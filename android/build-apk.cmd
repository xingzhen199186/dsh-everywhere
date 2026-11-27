@echo off
REM Build the Android APK (bridge variant) on Windows.
REM Prereq: build inputs fetched first — node scripts\fetch-build-deps.mjs
REM Signing: set DSH_KS_PATH / DSH_KS_PASSWORD / DSH_KS_ALIAS in the environment,
REM or put them in gradle.properties. Nothing secret lives in this file.
chcp 936 >nul
if "%ANDROID_HOME%"=="" (
  if exist "D:\Android\Sdk" set ANDROID_HOME=D:\Android\Sdk
)
if "%ANDROID_HOME%"=="" (
  echo [error] ANDROID_HOME is not set and D:\Android\Sdk was not found.
  exit /b 1
)
cd /d "%~dp0"
if "%JAVA_HOME%"=="" (
  echo [error] JAVA_HOME is not set.
  exit /b 1
)
"%JAVA_HOME%\bin\java" -classpath gradle\wrapper\gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain :app:assembleBridgeDebug --no-daemon %*
