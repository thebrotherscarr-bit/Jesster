@echo off
rem Double-click to start SecondBrain on the Jesster notes kernel.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-secondbrain.ps1" %*
