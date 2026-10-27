#!/usr/bin/env python3
"""
Reproducible Android APK Builder for KDP Studio.

Packages the complete offline web application (HTML, CSS, ES modules, vendored
pdf-lib + fontkit, and OFL fonts) into a signed, 4-byte-aligned native Android
APK (`downloads/kdp-studio.apk`) with V1 + V2 + V3 APK signatures.
"""

import os
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ANDROID_DIR = REPO_ROOT / "android"
OUTPUT_APK = REPO_ROOT / "kdp-studio.apk"
DOWNLOADS_APK = REPO_ROOT / "downloads" / "kdp-studio.apk"

TOOLS_ROOT = Path(os.environ.get("APK_TOOLS_DIR", "/tmp/apk-tools"))
SDK_DIR = TOOLS_ROOT / "sdk"
JAVA_HOME = Path(
    os.environ.get(
        "JAVA_HOME",
        str(TOOLS_ROOT / "venv/lib/python3.11/site-packages/jdk4py/java-runtime"),
    )
)

JAVA_BIN = JAVA_HOME / "bin" / "java"
KEYTOOL_BIN = JAVA_HOME / "bin" / "keytool"
AAPT2_BIN = SDK_DIR / "aapt2"
ANDROID_JAR = SDK_DIR / "android.jar"
ECJ_JAR = SDK_DIR / "ecj.jar"
D8_JAR = SDK_DIR / "d8.jar"
APKSIGNER_JAR = SDK_DIR / "apksigner.jar"

WEB_FILES = [
    "index.html",
    "manifest.webmanifest",
    "sw.js",
]
WEB_DIRS = [
    "styles",
    "js",
    "vendor",
    "fonts",
    "icons",
]


def run(cmd, cwd=None):
    print("  $", " ".join(str(c) for c in cmd))
    res = subprocess.run(cmd, cwd=cwd, text=True, capture_output=True)
    if res.returncode != 0:
        sys.stderr.write(res.stdout)
        sys.stderr.write(res.stderr)
        raise RuntimeError(f"Command failed with exit code {res.returncode}: {cmd[0]}")
    return res.stdout


def stage_web_assets(stage_assets_dir: Path):
    www_dir = stage_assets_dir / "www"
    www_dir.mkdir(parents=True, exist_ok=True)
    count = 0
    for rel in WEB_FILES:
        src = REPO_ROOT / rel
        dst = www_dir / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        count += 1

    for folder in WEB_DIRS:
        src_dir = REPO_ROOT / folder
        for path in sorted(src_dir.rglob("*")):
            if path.is_file():
                rel = path.relative_to(REPO_ROOT)
                dst = www_dir / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, dst)
                count += 1
    print(f"[1/6] Staged {count} offline web assets into assets/www/")


def zipalign_4_with_dex(base_apk: Path, dex_file: Path, aligned_apk: Path):
    """
    Merges classes.dex into the linked AAPT2 APK and writes a fresh ZIP archive
    where every uncompressed (ZIP_STORED) entry — notably resources.arsc, fonts,
    and PNG icons — has its payload aligned to an exact 4-byte offset, satisfying
    Android 11+ (targetSdkVersion >= 30) PackageManager rules.
    """
    uncompressed_exts = {".arsc", ".woff", ".woff2", ".png", ".jpg", ".jpeg", ".webp"}

    entries = []
    with zipfile.ZipFile(base_apk, "r") as zin:
        for info in zin.infolist():
            if info.filename.startswith("META-INF/"):
                continue
            data = zin.read(info.filename)
            ext = Path(info.filename).suffix.lower()
            store = (info.filename == "resources.arsc") or (ext in uncompressed_exts)
            entries.append((info.filename, data, store))

    entries.append(("classes.dex", dex_file.read_bytes(), False))

    with open(aligned_apk, "wb") as raw_out:
        with zipfile.ZipFile(raw_out, "w") as zout:
            for filename, data, store in entries:
                zinfo = zipfile.ZipInfo(filename=filename, date_time=(2026, 1, 1, 0, 0, 0))
                zinfo.external_attr = 0o644 << 16
                if store:
                    zinfo.compress_type = zipfile.ZIP_STORED
                    current_offset = raw_out.tell()
                    name_len = len(filename.encode("utf-8"))
                    # Local file header is 30 bytes + filename + extra
                    unpadded_data_offset = current_offset + 30 + name_len
                    pad_needed = (4 - (unpadded_data_offset % 4)) % 4
                    zinfo.extra = b"\x00" * pad_needed
                    zout.writestr(zinfo, data, compress_type=zipfile.ZIP_STORED)
                else:
                    zinfo.compress_type = zipfile.ZIP_DEFLATED
                    zinfo.extra = b""
                    zout.writestr(zinfo, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def verify_alignment(apk_path: Path):
    with open(apk_path, "rb") as f, zipfile.ZipFile(apk_path, "r") as zf:
        for info in zf.infolist():
            f.seek(info.header_offset)
            sig, _, _, _, _, _, _, _, _, fname_len, extra_len = struct.unpack(
                "<4sHHHHHIIIHH", f.read(30)
            )
            assert sig == b"PK\x03\x04", f"Bad local header for {info.filename}"
            data_offset = info.header_offset + 30 + fname_len + extra_len
            if info.filename == "resources.arsc":
                assert info.compress_type == zipfile.ZIP_STORED, "resources.arsc must be STORED"
                assert data_offset % 4 == 0, f"resources.arsc misaligned: offset {data_offset}"
            elif info.compress_type == zipfile.ZIP_STORED:
                assert data_offset % 4 == 0, f"{info.filename} misaligned: offset {data_offset}"


def build():
    for required in [JAVA_BIN, KEYTOOL_BIN, AAPT2_BIN, ANDROID_JAR, ECJ_JAR, D8_JAR, APKSIGNER_JAR]:
        if not required.exists():
            raise FileNotFoundError(f"Missing required build tool: {required}")

    OUTPUT_APK.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="kdp-apk-build-") as tmp:
        work = Path(tmp)
        stage_assets = work / "assets"
        gen_java = work / "gen"
        classes_dir = work / "classes"
        dex_dir = work / "dex"
        compiled_res_zip = work / "compiled_res.zip"
        base_apk = work / "base.apk"
        aligned_apk = work / "aligned.apk"
        keystore = work / "kdp-release.jks"

        for d in [stage_assets, gen_java, classes_dir, dex_dir]:
            d.mkdir(parents=True, exist_ok=True)

        stage_web_assets(stage_assets)

        print("[2/6] Compiling Android resources with AAPT2...")
        run([
            str(AAPT2_BIN),
            "compile",
            "--dir",
            str(ANDROID_DIR / "res"),
            "-o",
            str(compiled_res_zip),
        ])

        print("[3/6] Linking resources, AndroidManifest.xml, and assets...")
        run([
            str(AAPT2_BIN),
            "link",
            "-I",
            str(ANDROID_JAR),
            "--manifest",
            str(ANDROID_DIR / "AndroidManifest.xml"),
            "-A",
            str(stage_assets),
            "--java",
            str(gen_java),
            "-0",
            "arsc",
            "-0",
            "woff",
            "-0",
            "png",
            "-o",
            str(base_apk),
            str(compiled_res_zip),
        ])

        java_sources = sorted(
            [str(p) for p in (ANDROID_DIR / "src").rglob("*.java")]
            + [str(p) for p in gen_java.rglob("*.java")]
        )
        print(f"[4/6] Compiling {len(java_sources)} Java sources with ECJ + D8 -> classes.dex...")
        run([
            str(JAVA_BIN),
            "-jar",
            str(ECJ_JAR),
            "-1.8",
            "-encoding",
            "UTF-8",
            "-bootclasspath",
            str(ANDROID_JAR),
            "-d",
            str(classes_dir),
            *java_sources,
        ])

        class_files = sorted(str(p) for p in classes_dir.rglob("*.class"))
        run([
            str(JAVA_BIN),
            "-cp",
            str(D8_JAR),
            "com.android.tools.r8.D8",
            "--release",
            "--min-api",
            "24",
            "--lib",
            str(ANDROID_JAR),
            "--output",
            str(dex_dir),
            *class_files,
        ])

        print("[5/6] Merging classes.dex and 4-byte zipaligning uncompressed entries...")
        zipalign_4_with_dex(base_apk, dex_dir / "classes.dex", aligned_apk)
        verify_alignment(aligned_apk)

        print("[6/6] Signing APK (V1 + V2 + V3 schemes) and verifying...")
        ks_pass = "kdpstudio2026"
        run([
            str(KEYTOOL_BIN),
            "-genkeypair",
            "-keystore",
            str(keystore),
            "-storepass",
            ks_pass,
            "-keypass",
            ks_pass,
            "-alias",
            "kdpstudio",
            "-keyalg",
            "RSA",
            "-keysize",
            "2048",
            "-sigalg",
            "SHA256withRSA",
            "-validity",
            "10000",
            "-dname",
            "CN=KDP Studio, OU=Publishing Tools, O=KDP Studio, L=Kolkata, S=WB, C=IN",
        ])

        run([
            str(JAVA_BIN),
            "-jar",
            str(APKSIGNER_JAR),
            "sign",
            "--ks",
            str(keystore),
            "--ks-key-alias",
            "kdpstudio",
            "--ks-pass",
            f"pass:{ks_pass}",
            "--key-pass",
            f"pass:{ks_pass}",
            "--v1-signing-enabled",
            "true",
            "--v2-signing-enabled",
            "true",
            "--v3-signing-enabled",
            "true",
            "--out",
            str(OUTPUT_APK),
            str(aligned_apk),
        ])

        verify_out = run([
            str(JAVA_BIN),
            "-jar",
            str(APKSIGNER_JAR),
            "verify",
            "--verbose",
            "--print-certs",
            str(OUTPUT_APK),
        ])
        print(verify_out.strip())

        badging = run([
            str(AAPT2_BIN),
            "dump",
            "badging",
            str(OUTPUT_APK),
        ])
        print(badging.strip())

    DOWNLOADS_APK.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(OUTPUT_APK, DOWNLOADS_APK)
    size_kb = OUTPUT_APK.stat().st_size / 1024
    print(f"\nSUCCESS: Built signed Android APK -> {OUTPUT_APK} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    build()
