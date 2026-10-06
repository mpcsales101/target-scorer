#!/usr/bin/env bash
# Builds a signed, sideloadable APK of the web app: ../dist/TargetScorer.apk
# Tools (JDK 21 + Android SDK) live in ~/android-build-tools; the signing key is kept there too,
# outside the repo. Keep that key: updates must be signed with the same one.
set -euo pipefail
cd "$(dirname "$0")"

TOOLS="${ANDROID_TOOLS:-$HOME/android-build-tools}"
export JAVA_HOME="$(ls -d "$TOOLS"/jdk-21*/Contents/Home | head -1)"
export ANDROID_HOME="$TOOLS/sdk"
export PATH="$JAVA_HOME/bin:$PATH"

# 1. Copy the web app in.
rm -rf www && mkdir www
cp -R ../index.html ../css ../js ../icons ../manifest.webmanifest www/

# 2. Create the Android project once, then sync the web files into it.
FIRST=0
[ -d android ] || { npx cap add android; FIRST=1; }
npx cap sync android

MANIFEST=android/app/src/main/AndroidManifest.xml
if ! grep -q 'android.permission.CAMERA' "$MANIFEST"; then
  sed -i '' 's#<uses-permission android:name="android.permission.INTERNET" />#&\
    <uses-permission android:name="android.permission.CAMERA" />\
    <uses-feature android:name="android.hardware.camera" android:required="false" />#' "$MANIFEST"
fi

# App icon: our target icon at every density (drop Capacitor's adaptive icon XML).
if [ "$FIRST" = 1 ] || [ ! -f android/app/src/main/res/.icons-done ]; then
  rm -rf android/app/src/main/res/mipmap-anydpi-v26
  for pair in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
    d=${pair%%:*}; px=${pair##*:}; dir=android/app/src/main/res/mipmap-$d
    for n in ic_launcher ic_launcher_round ic_launcher_foreground; do
      [ -f "$dir/$n.png" ] && sips -z "$px" "$px" ../icons/icon-512.png --out "$dir/$n.png" >/dev/null
    done
  done
  touch android/app/src/main/res/.icons-done
fi

# A rising version code lets each new APK install over the last one.
sed -i '' -E "s/versionCode [0-9]+/versionCode $(( $(date +%s) / 60 ))/" android/app/build.gradle

# 3. Build.
(cd android && ./gradlew --no-daemon -q assembleRelease)

# 4. Sign.
KEYDIR="$TOOLS/keys" KEY="$TOOLS/keys/target-scorer.jks" PASS="$TOOLS/keys/password.txt"
if [ ! -f "$KEY" ]; then
  mkdir -p "$KEYDIR"
  openssl rand -hex 16 > "$PASS"
  keytool -genkeypair -keystore "$KEY" -alias targetscorer -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$(cat "$PASS")" -keypass "$(cat "$PASS")" -dname "CN=Target Scorer" >/dev/null
fi
BT="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"
mkdir -p ../dist
ALIGNED="$(mktemp -t ts-aligned).apk"
"$BT/zipalign" -f -p 4 android/app/build/outputs/apk/release/app-release-unsigned.apk "$ALIGNED"
"$BT/apksigner" sign --ks "$KEY" --ks-pass "file:$PASS" --out ../dist/TargetScorer.apk "$ALIGNED"
rm -f "$ALIGNED" ../dist/TargetScorer.apk.idsig
ls -lh ../dist/TargetScorer.apk
