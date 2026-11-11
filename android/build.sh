#!/usr/bin/env bash
# Builds the Dex Art Android app (android/dist/dex-art.apk) with the Android tools Ubuntu packages:
#   sudo apt-get install -y openjdk-17-jdk-headless android-sdk-platform-23 aapt dalvik-exchange zipalign apksigner
# Signing: set KEYSTORE (path), KEYSTORE_PASS and KEY_ALIAS. Without KEYSTORE a key is made in android/keystore/
# the first time; keep that file: updates of the app must be signed with the same key.
# Version: VERSION_NAME (default 1.0) and VERSION_CODE (default: the number of git commits, else 1).
set -euo pipefail
cd "$(dirname "$0")"

ANDROID_JAR=${ANDROID_JAR:-$(ls /usr/lib/android-sdk/platforms/android-*/android.jar | sort -V | tail -1)}
VERSION_NAME=${VERSION_NAME:-1.0}
VERSION_CODE=${VERSION_CODE:-$(git rev-list --count HEAD 2>/dev/null || echo 1)}
DX=$(command -v dalvik-exchange || command -v dx)

rm -rf build && mkdir -p build/gen build/classes dist
echo "== resources"
aapt package -f -m -J build/gen -M AndroidManifest.xml -S res -I "$ANDROID_JAR" \
  --min-sdk-version 24 --target-sdk-version 34 --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  -F build/app.unsigned.apk
echo "== java"
javac --release 8 -nowarn -encoding UTF-8 -classpath "$ANDROID_JAR" -d build/classes \
  $(find build/gen src -name '*.java')
echo "== dex"
"$DX" --dex --min-sdk-version=24 --output=build/classes.dex build/classes
(cd build && aapt add -f app.unsigned.apk classes.dex >/dev/null)
echo "== align and sign"
zipalign -p -f 4 build/app.unsigned.apk build/app.aligned.apk

KEYSTORE=${KEYSTORE:-keystore/dex-art.jks}
KEYSTORE_PASS=${KEYSTORE_PASS:-dexart-local}
KEY_ALIAS=${KEY_ALIAS:-dexart}
if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  keytool -genkeypair -keystore "$KEYSTORE" -storepass "$KEYSTORE_PASS" -keypass "$KEYSTORE_PASS" -alias "$KEY_ALIAS" \
    -keyalg RSA -keysize 3072 -validity 10000 -dname "CN=Dex Art Tracker" >/dev/null 2>&1
  echo "   new signing key: $KEYSTORE (keep it: updates must use the same key)"
fi
apksigner sign --ks "$KEYSTORE" --ks-pass "pass:$KEYSTORE_PASS" --ks-key-alias "$KEY_ALIAS" \
  --min-sdk-version 24 --out dist/dex-art.apk build/app.aligned.apk
apksigner verify dist/dex-art.apk
echo "== done: android/dist/dex-art.apk ($(du -h dist/dex-art.apk | cut -f1), version $VERSION_NAME / $VERSION_CODE)"
