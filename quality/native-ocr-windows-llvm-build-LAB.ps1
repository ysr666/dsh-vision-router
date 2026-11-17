# Isolated Windows x64 LLVM-MinGW/PP-OCRv6 build. No download,
# publishing, DSH installation, or modification of any system compiler.
param([Parameter(Mandatory=$true)][string]$LabRoot,
      [Parameter(Mandatory=$true)][string]$RepoRoot,
      [switch]$Candidate)
$ErrorActionPreference='Stop'
$tool=Join-Path $LabRoot 'toolchain\llvm-mingw-20261020-ucrt-x86_64'
$zip=Join-Path $LabRoot 'llvm-mingw-20261020-ucrt-x86_64.zip'
if((Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne
 'fd5462b7f5d93b2ff981fcd3f9c7e427e47f3203c64ea91c27bcc444eebd74cd'){throw 'TOOLCHAIN_ZIP_SHA_MISMATCH'}
$cpp=Join-Path $RepoRoot 'quality\native-ocr-lab.cpp'
if((Get-FileHash $cpp -Algorithm SHA256).Hash.ToLowerInvariant() -ne
 '6e3d7e41bd4599b7f5625cd103935d1cc015295ac50b4abcfaa3d3913d5b091d'){throw 'CPP_SHA_MISMATCH'}
$gnu=Join-Path $tool 'include\stdarg.h'
$llvm=Join-Path $tool 'lib\clang\23\include\stdarg.h'
$llvmDigest='ce6e43d79dc89b50208ecf259b1ffd519f5a78cd3a2c7fcaac6386f376b89fef'
$gnuDigest='09f6041cdc0f2f3325828a0e1bfb05e2fb4fb0a73cf715a3b6cb5315612c8c56'
if((Get-FileHash $llvm -Algorithm SHA256).Hash.ToLowerInvariant() -ne $llvmDigest){throw 'LLVM_STDARG_SHA_MISMATCH'}
$seen=(Get-FileHash $gnu -Algorithm SHA256).Hash.ToLowerInvariant()
if($seen -ne $gnuDigest -and $seen -ne $llvmDigest){throw 'UNKNOWN_PLATFORM_STDARG'}
# The toolchain's fallback GCC header is GPL with a GCC-only exception.
# Replace ONLY in this extracted private toolchain with its built-in
# Apache-2.0 WITH LLVM Exceptions header. Touch so Ninja recompiles ncnn.
if($seen -eq $gnuDigest){Copy-Item $gnu (Join-Path $LabRoot 'original-gcc-stdarg-private.h') -Force}
Copy-Item $llvm $gnu -Force
(Get-Item $gnu).LastWriteTime=Get-Date
$bin=Join-Path $tool 'bin'
$cmake=(Get-Command 'cmake.exe' -ErrorAction SilentlyContinue).Source
if(-not $cmake){$cmake='C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'}
$ninja=(Get-Command 'ninja.exe' -ErrorAction SilentlyContinue).Source
if(-not $ninja){$ninja='C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe'}
$env:PATH="$bin;$(Split-Path $cmake);$(Split-Path $ninja);$env:PATH"
$ncnn=Join-Path $LabRoot 'ncnn'
if(Test-Path (Join-Path $ncnn '.git')){
  $revision=(& git.exe -C $ncnn rev-parse HEAD 2>$null)
  if($revision -ne 'd1f6ac67e9fc91390cc70f7168573fd2626f1d66'){throw 'NCNN_SOURCE_REVISION_MISMATCH'}
} else {
  # Exact source tree copied from the pinned ncnn commit, without .git;
  # hash every file (relative path + SHA-256) to guard against drift.
  $all=@(Get-ChildItem $ncnn -File -Recurse)
  if($all.Count -ne 4532){throw 'NCNN_SOURCE_FILECOUNT_MISMATCH'}
  [string[]]$relative=@($all|ForEach-Object {$_.FullName.Substring($ncnn.Length+1).Replace('\','/')})
  [Array]::Sort($relative,[StringComparer]::Ordinal)
  $sb=[Text.StringBuilder]::new()
  foreach($rel in $relative){
    $hash=(Get-FileHash (Join-Path $ncnn $rel.Replace('/','\')) -Algorithm SHA256).Hash.ToLowerInvariant()
    [void]$sb.Append($rel).Append([char]0).Append($hash).Append([char]10)
  }
  $sha=[Security.Cryptography.SHA256]::Create()
  $digest=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($sb.ToString()))).Replace('-','').ToLowerInvariant()
  if($digest -ne '2fb93b766406c4499d093e1d1c2f509363c2ef21a34fc448980ab99e327aefca'){throw "NCNN_SOURCE_TREE_SHA_MISMATCH=$digest"}
}
$build=Join-Path $LabRoot 'ncnn-build-windows-llvm'
$cc=Join-Path $bin 'x86_64-w64-mingw32-clang.exe'
$cxx=Join-Path $bin 'x86_64-w64-mingw32-clang++.exe'
$flags=@('-DCMAKE_BUILD_TYPE=Release',"-DCMAKE_C_COMPILER=$cc", "-DCMAKE_CXX_COMPILER=$cxx",
 '-DNCNN_OPENMP=OFF','-DNCNN_VULKAN=OFF','-DNCNN_SHARED_LIB=OFF',
 '-DNCNN_PIXEL=ON','-DNCNN_BUILD_TOOLS=OFF','-DNCNN_BUILD_EXAMPLES=OFF',
 '-DNCNN_BUILD_TESTS=OFF','-DNCNN_BUILD_BENCHMARK=OFF')
if($Candidate) {
  # A candidate intentionally has a different identity from past owner-built
  # workers. Suppress PE wall-clock timestamps and absolute build paths.
  $env:SOURCE_DATE_EPOCH='1794700800'
  $prefixFlags="-ffile-prefix-map=$LabRoot=/dvr-native -ffile-prefix-map=$RepoRoot=/dvr-src"
  $flags+=@("-DCMAKE_C_FLAGS=$prefixFlags","-DCMAKE_CXX_FLAGS=$prefixFlags")
}
& $cmake -S $ncnn -B $build -G Ninja @flags *> (Join-Path $LabRoot 'llvm-cmake-private.log')
if($LASTEXITCODE -ne 0){throw 'NCNN_CMAKE_FAILED'}
& $cmake --build $build --target ncnn -j 6 *> (Join-Path $LabRoot 'llvm-build-private.log')
if($LASTEXITCODE -ne 0){throw 'NCNN_BUILD_FAILED'}
$out=Join-Path $LabRoot 'worker-llvm-header-static.exe'
$linkFlags=@()
if($Candidate){
  $map=Join-Path $LabRoot 'candidate-link-map.txt'
  $linkFlags+=@("-ffile-prefix-map=$LabRoot=/dvr-native","-ffile-prefix-map=$RepoRoot=/dvr-src",
    '-Wl,--no-insert-timestamp',"-Wl,-Map,$map",'-H')
}
& $cxx -O2 -std=c++17 -static @linkFlags "-I$(Join-Path $ncnn 'src')" "-I$(Join-Path $build 'src')" $cpp (Join-Path $build 'src\libncnn.a') -o $out 2> (Join-Path $LabRoot 'candidate-wrapper-headers.txt')
if($LASTEXITCODE -ne 0){throw 'WORKER_LINK_FAILED'}
if($Candidate){
  & $ninja -C $build -t deps | Set-Content -Encoding utf8 (Join-Path $LabRoot 'candidate-ninja-deps.txt')
  if($LASTEXITCODE -ne 0){throw 'HEADER_INVENTORY_FAILED'}
}
$dump=& (Join-Path $bin 'llvm-objdump.exe') -p $out
$imports=@($dump|Select-String 'DLL Name:'|ForEach-Object {$_.Line.Trim().Substring(10).Trim()})
if($imports.Count -eq 0 -or @($imports|Where-Object {$_ -notmatch '^(KERNEL32\.dll|api-ms-win-crt-[a-z0-9-]+\.dll)$'}).Count -ne 0){throw 'UNEXPECTED_NON_SYSTEM_DLL'}
Write-Output ('WINDOWS_PERMISSIVE_HEADER_WORKER_SHA256='+((Get-FileHash $out -Algorithm SHA256).Hash.ToLowerInvariant()))
Write-Output ('WINDOWS_DLL_IMPORTS='+($imports -join ','))
