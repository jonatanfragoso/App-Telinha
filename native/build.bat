@echo off
rem Compila o audiocap.exe com o Visual Studio (rode no "x64 Native Tools Command Prompt").
cl /nologo /O2 /EHsc /std:c++17 /MT audiocap.cpp /Fe:audiocap.exe ole32.lib uuid.lib oleaut32.lib user32.lib
if errorlevel 1 exit /b 1
del /q audiocap.obj 2>nul
echo OK: native\audiocap.exe
