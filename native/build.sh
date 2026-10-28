#!/usr/bin/env bash
# Compila o audiocap.exe no Linux/WSL com MinGW.
#   sudo apt install g++-mingw-w64-x86-64-posix
set -e
cd "$(dirname "$0")"
x86_64-w64-mingw32-g++ -O2 -std=c++17 -static -static-libgcc -static-libstdc++ \
  audiocap.cpp -o audiocap.exe -lole32 -luuid -loleaut32
echo "OK: native/audiocap.exe"
