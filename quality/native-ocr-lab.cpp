// Isolated PP-OCRv6 small CPU experimental worker.
// Input: 'DVR3OCR1' + little-endian uint32 width + height + payloadBytes + RGB24 pixels.
// Output: single JSON object {"text": "...", "confidence": 0..1}
// BSD-3-Clause ncnn runtime; no OpenCV, Python, ONNX Runtime or image decoder.
// This is a lab artifact and must NOT be auto-enabled in production.
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include "net.h"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cerrno>
#include <cstdlib>
#include <cctype>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <numeric>
#include <queue>
#include <sstream>
#include <string>
#include <utility>
#include <vector>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif
#ifdef __linux__
#include <csignal>
#include <sys/prctl.h>
#include <sys/types.h>
#include <unistd.h>
#endif

namespace {
constexpr int MAX_SIDE = 4096;
constexpr uint64_t MAX_PIXELS = 4'000'000;
constexpr int MAX_DET_SIDE = 768;
constexpr int PAD = 40;
constexpr float BITMAP_THRESHOLD = 0.30f;
constexpr float BOX_THRESHOLD = 0.45f;
constexpr float CONFIDENCE_THRESHOLD = 0.80f;

struct Box {
  int x1, y1, x2, y2;
  float score;
};
struct Text {
  std::string value;
  float confidence = 0;
};
bool readExact(char* dst, size_t len) {
  while (len) {
    std::cin.read(dst, static_cast<std::streamsize>(len));
    const auto amount = std::cin.gcount();
    if (amount <= 0) return false;
    dst += amount;
    len -= static_cast<size_t>(amount);
  }
  return true;
}
uint32_t read32(const unsigned char* p) {
  return static_cast<uint32_t>(p[0]) |
    (static_cast<uint32_t>(p[1]) << 8) |
    (static_cast<uint32_t>(p[2]) << 16) |
    (static_cast<uint32_t>(p[3]) << 24);
}
std::string escapeJson(const std::string& x) {
  std::ostringstream out;
  for (unsigned char c : x) {
    if (c == '"') out << "\\\"";
    else if (c == '\\') out << "\\\\";
    else if (c == '\n') out << "\\n";
    else if (c == '\r') out << "\\r";
    else if (c == '\t') out << "\\t";
    else if (c < 32) {
      out << "\\u00" << std::hex << std::setw(2) << std::setfill('0') << int(c) << std::dec;
    } else out << static_cast<char>(c);
  }
  return out.str();
}
bool ambiguousLatinNumberToken(const std::string& input) {
  std::string token;
  const auto risky = [](const std::string& t) {
    bool alpha=false,digit=false,confusable=false;
    for (unsigned char c:t) {
      if (std::isalpha(c)) alpha=true;
      if (std::isdigit(c)) digit=true;
      if (c=='0' || c=='O' || c=='o' || c=='1' || c=='I' || c=='l') confusable=true;
    }
    return alpha && digit && confusable;
  };
  for (unsigned char c:input) {
    if (c<128 && (std::isalnum(c) || c=='-' || c=='_' || c=='.')) token+=char(c);
    else {
      if (risky(token)) return true;
      token.clear();
    }
  }
  return risky(token);
}
bool loadDictionary(const std::string& path, std::vector<std::string>& chars) {
  std::ifstream input(path, std::ios::binary);
  if (!input) return false;
  chars.push_back("");
  std::string line;
  while (std::getline(input, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    chars.push_back(line);
  }
  chars.push_back(" ");
  return chars.size() == 18710;
}
std::vector<Box> detect(const std::vector<unsigned char>& rgb, int width, int height, ncnn::Net& net) {
  const int W = width + 2 * PAD, H = height + 2 * PAD;
  std::vector<unsigned char> padded(static_cast<size_t>(W) * H * 3, 255);
  for (int y = 0; y < height; ++y)
    std::memcpy(padded.data() + (static_cast<size_t>(y + PAD) * W + PAD) * 3,
      rgb.data() + static_cast<size_t>(y) * width * 3, static_cast<size_t>(width) * 3);

  const float scale = std::min(1.f, static_cast<float>(MAX_DET_SIDE) / std::max(W, H));
  const int dw = std::max(32, static_cast<int>(std::round(W * scale / 32)) * 32);
  const int dh = std::max(32, static_cast<int>(std::round(H * scale / 32)) * 32);
  ncnn::Mat input = ncnn::Mat::from_pixels_resize(padded.data(), ncnn::Mat::PIXEL_RGB2BGR,
    W, H, dw, dh);
  const float mean[] = {0.485f * 255, 0.456f * 255, 0.406f * 255};
  const float norm[] = {1.f / (0.229f * 255), 1.f / (0.224f * 255), 1.f / (0.225f * 255)};
  input.substract_mean_normalize(mean, norm);
  ncnn::Extractor ex = net.create_extractor();
  if (ex.input("in0", input) != 0) return {};
  ncnn::Mat output;
  if (ex.extract("out0", output) != 0 || output.w != dw || output.h != dh) return {};
  const int pixels = dw * dh;
  // Rectangular probability average rejects large colorful background blobs
  // without suppressing individual thin Chinese strokes.
  const int stride = dw + 1;
  std::vector<double> integral(static_cast<size_t>(stride) * (dh + 1), 0.0);
  for (int iy=1;iy<=dh;++iy) {
    double running=0;
    const auto* line=output.row<const float>(iy-1);
    for (int ix=1;ix<=dw;++ix) {
      running+=line[ix-1];
      integral[static_cast<size_t>(iy)*stride+ix] =
        integral[static_cast<size_t>(iy-1)*stride+ix] + running;
    }
  }
  const auto scoreRegion = [&](int ax,int ay,int bx,int by) {
    const double total =
      integral[static_cast<size_t>(by+1)*stride+(bx+1)]
      - integral[static_cast<size_t>(ay)*stride+(bx+1)]
      - integral[static_cast<size_t>(by+1)*stride+ax]
      + integral[static_cast<size_t>(ay)*stride+ax];
    return static_cast<float>(total/((bx-ax+1)*(by-ay+1)));
  };
  std::vector<uint8_t> seen(static_cast<size_t>(pixels));
  std::vector<Box> boxes;
  std::vector<int> todo;
  todo.reserve(4096);
  int components = 0;
  const int deltaX[8] = {-1,0,1,-1,1,-1,0,1};
  const int deltaY[8] = {-1,-1,-1,0,0,1,1,1};
  for (int y = 0; y < dh && components < 12000; ++y) {
    for (int x = 0; x < dw; ++x) {
      const int start = y * dw + x;
      if (seen[start] || output.row<const float>(y)[x] <= BITMAP_THRESHOLD) continue;
      ++components;
      todo.clear();
      todo.push_back(start);
      seen[start] = 1;
      int minx=x,maxx=x,miny=y,maxy=y;
      size_t n=0;
      float accumulated=0;
      for (size_t at=0;at<todo.size();++at) {
        const int idx=todo[at],xx=idx%dw,yy=idx/dw;
        minx=std::min(minx,xx);maxx=std::max(maxx,xx);
        miny=std::min(miny,yy);maxy=std::max(maxy,yy);
        accumulated += output.row<const float>(yy)[xx];
        ++n;
        for (int k=0;k<8;++k) {
          const int nx=xx+deltaX[k],ny=yy+deltaY[k];
          if (nx<0 || nx>=dw || ny<0 || ny>=dh) continue;
          const int next=ny*dw+nx;
          if (!seen[next] && output.row<const float>(ny)[nx]>BITMAP_THRESHOLD) {
            seen[next]=1;
            todo.push_back(next);
          }
        }
      }
      if (n<8 || minx==maxx || miny==maxy) continue;
      // Approximate rotated DB box scoring for slanted long subtitle lines.
      // An axis-aligned rectangle can include enough empty background to
      // falsely reject an otherwise high-quality ~3 degree rotated line.
      float score=scoreRegion(minx,miny,maxx,maxy);
      if (score<BOX_THRESHOLD && maxx-minx>3*(maxy-miny) && n>=32) {
        double mx=0,my=0,cxx=0,cxy=0,cyy=0;
        for(int idx:todo) { mx+=idx%dw; my+=idx/dw; }
        mx/=n;my/=n;
        for(int idx:todo) {
          const double dx=idx%dw-mx,dy=idx/dw-my;
          cxx+=dx*dx;cxy+=dx*dy;cyy+=dy*dy;
        }
        const double angle=0.5*std::atan2(2*cxy,cxx-cyy);
        if (std::abs(angle)>.015 && std::abs(angle)<.30) {
          const double co=std::cos(angle),si=std::sin(angle);
          double minU=1e30,maxU=-1e30,minV=1e30,maxV=-1e30;
          for(int idx:todo) {
            const double dx=idx%dw-mx,dy=idx/dw-my;
            const double u=dx*co+dy*si,v=-dx*si+dy*co;
            minU=std::min(minU,u);maxU=std::max(maxU,u);
            minV=std::min(minV,v);maxV=std::max(maxV,v);
          }
          double total=0;
          size_t count=0;
          for(int yy=miny;yy<=maxy;++yy) {
            const float* line=output.row<const float>(yy);
            for(int xx=minx;xx<=maxx;++xx) {
              const double dx=xx-mx,dy=yy-my;
              const double u=dx*co+dy*si,v=-dx*si+dy*co;
              if(u>=minU-.5 && u<=maxU+.5 && v>=minV-.5 && v<=maxV+.5) {
                total+=line[xx];
                ++count;
              }
            }
          }
          if(count) score=std::max(score,static_cast<float>(total/count));
        }
      }
      if (score<BOX_THRESHOLD) continue;
      const float cx=(minx+maxx)*.5f,cy=(miny+maxy)*.5f;
      const float halfw=(maxx-minx+1)*0.85f,halfh=(maxy-miny+1)*0.85f;
      const int x1=std::clamp(static_cast<int>(std::floor((cx-halfw)*W/dw-PAD)),0,width-1);
      const int x2=std::clamp(static_cast<int>(std::ceil((cx+halfw)*W/dw-PAD)),1,width);
      const int y1=std::clamp(static_cast<int>(std::floor((cy-halfh)*H/dh-PAD)),0,height-1);
      const int y2=std::clamp(static_cast<int>(std::ceil((cy+halfh)*H/dh-PAD)),1,height);
      if (x2-x1<5 || y2-y1<5) continue;
      boxes.push_back({x1,y1,x2,y2,score});
      if (boxes.size()>300) break;
    }
    if (boxes.size()>300) break;
  }
  // A comparator based on "y within 16 pixels" is NOT transitive and can
  // trigger undefined behavior in std::sort. Use stable, strict ordering.
  // A later reading-order layout pass can group rows/columns explicitly.
  std::stable_sort(boxes.begin(),boxes.end(),[](const Box&a,const Box&b) {
    if (a.y1!=b.y1) return a.y1<b.y1;
    if (a.x1!=b.x1) return a.x1<b.x1;
    if (a.y2!=b.y2) return a.y2<b.y2;
    return a.x2<b.x2;
  });
  return boxes;
}
Text recognize(const std::vector<unsigned char>& rgb, int width, int height,
  const Box& box, ncnn::Net& net, const std::vector<std::string>& chars) {
  const int cw=box.x2-box.x1,ch=box.y2-box.y1;
  if (cw<=1 || ch<=1) return {};
  std::vector<unsigned char> crop(static_cast<size_t>(cw)*ch*3);
  for (int y=0;y<ch;++y)
    std::memcpy(crop.data()+static_cast<size_t>(y)*cw*3,
      rgb.data()+(static_cast<size_t>(y+box.y1)*width+box.x1)*3,static_cast<size_t>(cw)*3);
  const int targetW=std::min(1536,std::max(24,static_cast<int>(std::round(cw*48.f/ch))));
  ncnn::Mat input=ncnn::Mat::from_pixels_resize(crop.data(),ncnn::Mat::PIXEL_RGB2BGR,
    cw,ch,targetW,48);
  const float mean[]={127.5f,127.5f,127.5f};
  const float norm[]={1.f/127.5f,1.f/127.5f,1.f/127.5f};
  input.substract_mean_normalize(mean,norm);
  ncnn::Extractor ex=net.create_extractor();
  if (ex.input("in0",input)!=0) return {};
  ncnn::Mat output;
  if (ex.extract("out0",output)!=0 || output.w!=static_cast<int>(chars.size()))return {};
  Text text;
  int previous=-1,recognized=0;
  for (int t=0;t<output.h;++t) {
    const auto* line=output.row<const float>(t);
    int best=0;
    float bestScore=line[0];
    for (int i=1;i<output.w;++i)if(line[i]>bestScore){bestScore=line[i];best=i;}
    if(best!=0 && best!=previous && std::isfinite(bestScore)){
      text.value+=chars[best];
      text.confidence+=bestScore;
      ++recognized;
    }
    previous=best;
  }
  if(recognized)text.confidence/=recognized;
  return text;
}
}
int main(int argc, char**argv) {
  if (argc!=2 || !argv[1]) return 2;
#ifdef __linux__
  // Even SIGKILL of a DSH Host must not leave an expensive native inference
  // running indefinitely. Register the parent-death signal before decoding
  // any image and verify that the original parent did not die in the race.
  const pid_t parentBefore = getppid();
  if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || getppid() != parentBefore)
    return 6;
  // The Node supervisor passes the expected PID in an otherwise sanitized
  // environment. This also catches death before exec/main and allows PID 1
  // when the Host is legitimately the container's init process.
  if (const char* claimed = std::getenv("DVR_OCR_PARENT_PID")) {
    errno = 0;
    char* end = nullptr;
    const long parsed = std::strtol(claimed, &end, 10);
    if (errno != 0 || end == claimed || *end != '\0' ||
        parsed < 1 || parsed > std::numeric_limits<pid_t>::max() ||
        static_cast<pid_t>(parsed) != getppid()) return 6;
  }
#endif
  const std::filesystem::path modelDir(argv[1]);
  if (!modelDir.is_absolute()) return 2;
  const std::string dir=modelDir.string();
#ifdef _WIN32
  // Windows CRT stdin is text mode by default: CRLF translation and Ctrl+Z
  // otherwise corrupt arbitrary RGB bytes and cause false short reads.
  if (_setmode(_fileno(stdin), _O_BINARY) == -1 ||
      _setmode(_fileno(stdout), _O_BINARY) == -1) return 2;
#endif
  unsigned char header[20];
  if (!readExact(reinterpret_cast<char*>(header),20) ||
      std::memcmp(header,"DVR3OCR1",8)!=0) return 3;
  const uint32_t width=read32(header+8),height=read32(header+12),len=read32(header+16);
  const uint64_t pixels=static_cast<uint64_t>(width)*height;
  if (!width || !height || width>MAX_SIDE || height>MAX_SIDE || pixels>MAX_PIXELS ||
      len!=pixels*3) return 3;
  std::vector<unsigned char> rgb(static_cast<size_t>(len));
  if (!readExact(reinterpret_cast<char*>(rgb.data()),rgb.size())) return 3;
  if(std::cin.peek()!=std::char_traits<char>::eof())return 3;
  ncnn::Net det,rec;
  det.opt.num_threads=1;
  rec.opt.num_threads=1;
  det.opt.use_vulkan_compute=false;
  rec.opt.use_vulkan_compute=false;
  if(det.load_param((dir+"/det.ncnn.param").c_str())!=0 ||
     det.load_model((dir+"/det.ncnn.bin").c_str())!=0 ||
     rec.load_param((dir+"/rec.ncnn.param").c_str())!=0 ||
     rec.load_model((dir+"/rec.ncnn.bin").c_str())!=0) return 4;
  std::vector<std::string> chars;
  if(!loadDictionary(dir+"/ppocrv6_dict.txt",chars))return 4;
  auto boxes=detect(rgb,static_cast<int>(width),static_cast<int>(height),det);
  std::string result,regionJson;
  float confSum=0;int confCount=0;
  for(const Box& box:boxes){
    Text text=recognize(rgb,static_cast<int>(width),static_cast<int>(height),box,rec,chars);
    if(text.value.empty() || text.confidence<CONFIDENCE_THRESHOLD)continue;
    if(!result.empty())result+="\n";
    result+=text.value;
    confSum+=text.confidence;
    ++confCount;
    if (!regionJson.empty()) regionJson+=",";
    std::ostringstream line;
    line << "{\"box\":[" << box.x1 << "," << box.y1 << "," << box.x2 << "," << box.y2
         << "],\"text\":\"" << escapeJson(text.value) << "\",\"confidence\":"
         << std::fixed << std::setprecision(5) << text.confidence
         << ",\"uncertain\":" << (ambiguousLatinNumberToken(text.value) ? "true" : "false")
         << "}";
    regionJson += line.str();
  }
  const float confidence=confCount?confSum/confCount:0.f;
  const bool ambiguous=ambiguousLatinNumberToken(result);
  std::cout<<"{\"text\":\""<<escapeJson(result)<<"\",\"confidence\":"
           <<std::fixed<<std::setprecision(5)<<confidence
           <<",\"uncertain\":"<<((!confCount || ambiguous)?"true":"false")
           <<(ambiguous?",\"review\":\"confusable_alphanumeric\"":"")
           <<",\"regions\":["<<regionJson<<"]}\n";
  return std::cout.good()?0:5;
}
