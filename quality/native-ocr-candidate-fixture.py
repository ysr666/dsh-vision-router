"""Generate a protocol smoke-test bitmap with synthetic block glyphs.
No fonts or user images are fetched or redistributed. This is not an accuracy benchmark.
"""
import argparse
from pathlib import Path
import struct

GLYPHS = {
    'T': ['11111','00100','00100','00100','00100','00100','00100'],
    'E': ['11111','10000','10000','11110','10000','10000','11111'],
    'S': ['01111','10000','10000','01110','00001','00001','11110'],
    '1': ['00100','01100','00100','00100','00100','00100','01110'],
    '2': ['01110','10001','00001','00010','00100','01000','11111'],
    '3': ['11110','00001','00001','01110','00001','00001','11110'],
    ' ': ['00000'] * 7,
}
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    w,h,scale = 760,160,11
    stride = (w*3+3)//4*4
    rgb = bytearray(b'\xff'*(stride*h))
    for i,char in enumerate('TEST 123'):
        for y,line in enumerate(GLYPHS[char]):
            for x,bit in enumerate(line):
                if bit == '1':
                    for yy in range(scale):
                        start = (h-1-(36+y*scale+yy))*stride+(30+(i*6+x)*scale)*3
                        rgb[start:start+scale*3] = b'\x10'*(scale*3)
    data = (b'BM'+struct.pack('<IHHI',54+len(rgb),0,0,54) +
            struct.pack('<IiiHHIIiiII',40,w,h,1,24,0,len(rgb),2835,2835,0,0) + rgb)
    args.output.write_bytes(data)
if __name__ == '__main__':
    main()
