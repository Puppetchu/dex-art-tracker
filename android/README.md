# Dex Art for Android

A small Android app around your Dex Art Tracker server. It opens `<your server>/` full screen and uses the server for everything (logins, ticks, wish lists, pictures and card scanning), so it updates whenever the server does.

## Using it

1. Install `dex-art.apk` on the phone (allow "install unknown apps" for the browser or file manager you open it with).
2. On first start, enter the server address, for example `dex.example.com`. Use the https address of your reverse proxy: the camera only works over https. The address can be changed later: press Back on the main page and choose **Change server**.
3. The app starts as a **closed Pokédex**: pick your trainer, enter your password and it opens. Inside the app you only see your own dex. **Log out** closes it again. **View dex** (under the password) opens that trainer's dex without logging in, to look around; tap the lens there to go back to the trainer list.

- The app is for the trainer accounts. The admin uses `/admin/` in a web browser; the app never opens it.
- Pages of your server (except `/admin/`) open inside the app; other links (Cardmarket, TCGplayer) open in the phone's browser.
- The camera is only handed to pages of your own server. Android asks once for camera permission.
- If a reverse proxy with login (for example Pangolin) sits in front of the server, let everything except `/admin/` through without login, otherwise the app reports that it was sent to a login page. (App builds from before this change open `/view/`, which the server still answers.)

## Building

`build.sh` builds and signs `dist/dex-art.apk` with the Android tools Ubuntu packages (no Android Studio or Gradle needed):

```
sudo apt-get install -y openjdk-17-jdk-headless android-sdk-platform-23 aapt dalvik-exchange zipalign apksigner
KEYSTORE=/path/to/dex-art-signing-key.jks KEYSTORE_PASS='…' android/build.sh
```

Every version must be signed with the same key (`dex-art-signing-key.jks`), otherwise Android refuses to install it over the old app. Keep the key and its password safe and out of the repository (`android/keystore/` is ignored by git).

GitHub can build it for you: `.github/workflows/android.yml` runs on every change to `android/` (or by hand from the Actions tab) and offers the APK as a download on the run's page. It needs two repository secrets: `ANDROID_KEYSTORE_B64` (the key file as base64: `base64 -w0 dex-art-signing-key.jks`) and `ANDROID_KEYSTORE_PASS`.

The app targets Android 14 (API 34) and runs on Android 7 and newer. It is built against the API 23 library that Ubuntu ships, which is all a web view app like this needs.

## Getting it on a phone, and updates

- Every GitHub build is published as the release **android-latest** of the repository. On an Android phone, open your Dex Art Tracker website and tap **Android app** at the top: it downloads the newest build. Open the file and tap Install (Android asks once to allow installing apps from your browser).
- The app checks your server for a newer build once a day and offers it (**Download**, **Later**, **Skip this one**). The back-button menu has **Check for updates**. Updates install over the old app because every build is signed with the same key.
- If the "Publish as the latest release" step fails with a permission error, set the repository's Settings → Actions → General → Workflow permissions to **Read and write permissions**.
