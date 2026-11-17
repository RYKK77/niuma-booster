#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
牛马加油器 Windows 图标离线生成脚本。

基于项目根目录的 Assets/AppIcon.svg，使用本机 Chromium 内核浏览器（Edge 或 Chrome）
的无头 CDP（Chrome DevTools Protocol）单会话渲染 1024×1024 真透明 RGBA 原图，
再由 Pillow（Image.Resampling.LANCZOS）重采样生成 Windows 所需的全部图标资产：
  - windows/assets/icon.png     （256×256 RGBA 窗口与通知图标）
  - windows/assets/icon.ico     （16/24/32/48/64/128/256 七分辨率嵌入 ICO）
  - windows/assets/tray@2x.png  （32×32 高 DPI 托盘图标，对称裁切保留圆角与渐变）
  - windows/assets/tray.png     （16×16 标准托盘图标，对称裁切保证小尺寸辨识度）

说明：
  - 严格不使用 PyMuPDF（fitz），避免 SVG 渐变与阴影失真；
  - 内置标准库 RFC6455 WebSocket 客户端，零第三方网络依赖；
  - 若当前 Python 环境未安装 Pillow，自动探测 conda 环境（优先 tempTools）重执行。
"""

from __future__ import annotations

import argparse
import base64
import ctypes
import hashlib
import io
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Optional

if os.name == "nt":
    import winreg


def _probe_conda_python_with_pillow() -> Optional[str]:
    """探测本机包含 Pillow（PIL）的 Python 解释器路径，优先 tempTools 环境。"""
    candidates: list[Path] = []

    def add_env_dir(env_dir: Path, priority: bool = False) -> None:
        py = env_dir / ("python.exe" if os.name == "nt" else "bin/python")
        if py.is_file():
            if priority:
                candidates.insert(0, py)
            else:
                candidates.append(py)

    # 1. 若已有 CONDA_PREFIX 环境变量，先尝试其中 Python
    conda_prefix = os.environ.get("CONDA_PREFIX")
    if conda_prefix:
        p = Path(conda_prefix)
        add_env_dir(p, priority=(p.name.lower() == "temptools"))

    # 2. 通过 CONDA_EXE 或 PATH 中的 conda 查询所有环境
    conda_exe = os.environ.get("CONDA_EXE") or shutil.which("conda")
    if conda_exe and Path(conda_exe).is_file():
        try:
            proc = subprocess.run(
                [conda_exe, "info", "--envs", "--json"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            if proc.returncode == 0 and proc.stdout.strip():
                info = json.loads(proc.stdout)
                envs = [Path(e) for e in info.get("envs", [])]
                # 优先 tempTools，其余环境随后
                envs.sort(key=lambda e: (0 if e.name.lower() == "temptools" else 1, str(e)))
                for env_path in envs:
                    add_env_dir(env_path)
        except Exception:
            pass

    # 3. 常见 Anaconda / Miniconda 安装目录兜底扫描
    user_home = Path.home()
    common_roots = [
        Path("D:/anaconda"),
        Path("D:/miniconda3"),
        Path("C:/anaconda3"),
        Path("C:/miniconda3"),
        user_home / "anaconda3",
        user_home / "miniconda3",
        Path(os.environ.get("LOCALAPPDATA", "")) / "anaconda3",
        Path(os.environ.get("LOCALAPPDATA", "")) / "miniconda3",
    ]
    for root in common_roots:
        if not str(root) or not root.is_dir():
            continue
        temp_tools = root / "envs" / "tempTools"
        if temp_tools.is_dir():
            add_env_dir(temp_tools, priority=True)
        envs_dir = root / "envs"
        if envs_dir.is_dir():
            for child in sorted(envs_dir.iterdir()):
                if child.is_dir() and child.name.lower() != "temptools":
                    add_env_dir(child)
        add_env_dir(root)

    # 去重并保持顺序，优先验证 tempTools
    seen: set[str] = set()
    ordered: list[Path] = []
    for py in candidates:
        key = os.path.normcase(os.path.abspath(str(py)))
        if key not in seen:
            seen.add(key)
            ordered.append(py)
    ordered.sort(key=lambda p: 0 if "temptools" in str(p).lower() else 1)

    current_exe = os.path.normcase(os.path.abspath(sys.executable))
    for py in ordered:
        if os.path.normcase(os.path.abspath(str(py))) == current_exe:
            continue
        try:
            check = subprocess.run(
                [str(py), "-c", "import PIL.Image"],
                capture_output=True,
                timeout=10,
                check=False,
            )
            if check.returncode == 0:
                return str(py)
        except Exception:
            continue
    return None


def ensure_pillow_or_reexec() -> Any:
    """
    确保当前进程可导入 PIL.Image；若缺失则自动切换至含 Pillow 的 conda 环境重执行。
    """
    try:
        from PIL import Image  # noqa: WPS433

        return Image
    except ImportError:
        if "--_reexeced" in sys.argv:
            print(
                "错误：未找到可用的 Pillow（PIL）库。请先激活含 Pillow 的环境"
                "（例如 conda activate tempTools）或执行 pip install pillow。",
                file=sys.stderr,
            )
            sys.exit(1)

        alt_python = _probe_conda_python_with_pillow()
        if alt_python:
            print(f"[环境切换] 当前 Python 缺少 Pillow，自动使用环境解释器重执行：{alt_python}")
            cmd = [alt_python, str(Path(__file__).resolve()), "--_reexeced", *sys.argv[1:]]
            result = subprocess.run(cmd, check=False)
            sys.exit(result.returncode)

        print(
            "错误：当前 Python 缺少 Pillow（PIL），且未自动探测到含 Pillow 的 conda 环境。\n"
            "请先执行：conda activate tempTools\n"
            "或在当前环境安装：pip install pillow",
            file=sys.stderr,
        )
        sys.exit(1)


def _get_windows_file_version(exe_path: Path) -> Optional[str]:
    """读取 Windows 可执行文件的版本号（失败时返回 None）。"""
    if os.name != "nt":
        return None
    try:
        size = ctypes.windll.version.GetFileVersionInfoSizeW(str(exe_path), None)
        if not size:
            return None
        buf = ctypes.create_string_buffer(size)
        if not ctypes.windll.version.GetFileVersionInfoW(str(exe_path), 0, size, buf):
            return None
        ptr = ctypes.c_void_p()
        length = ctypes.c_uint()
        if not ctypes.windll.version.VerQueryValueW(buf, "\\", ctypes.byref(ptr), ctypes.byref(length)):
            return None

        class VSFixedFileInfo(ctypes.Structure):
            _fields_ = [
                ("dwSignature", ctypes.c_uint32),
                ("dwStrucVersion", ctypes.c_uint32),
                ("dwFileVersionMS", ctypes.c_uint32),
                ("dwFileVersionLS", ctypes.c_uint32),
                ("dwProductVersionMS", ctypes.c_uint32),
                ("dwProductVersionLS", ctypes.c_uint32),
                ("dwFileFlagsMask", ctypes.c_uint32),
                ("dwFileFlags", ctypes.c_uint32),
                ("dwFileOS", ctypes.c_uint32),
                ("dwFileType", ctypes.c_uint32),
                ("dwFileSubtype", ctypes.c_uint32),
                ("dwFileDateMS", ctypes.c_uint32),
                ("dwFileDateLS", ctypes.c_uint32),
            ]

        info = ctypes.cast(ptr, ctypes.POINTER(VSFixedFileInfo)).contents
        ms, ls = info.dwProductVersionMS, info.dwProductVersionLS
        return f"{ms >> 16}.{ms & 0xFFFF}.{ls >> 16}.{ls & 0xFFFF}"
    except Exception:
        return None


def find_chromium_browser(explicit_path: Optional[str] = None) -> Path:
    """
    按顺序自动探测可用的 Chromium 内核浏览器（Edge / Chrome）：
      1. 命令行 --browser 参数
      2. 环境变量 NIUMA_ICON_BROWSER
      3. PATH（shutil.which）
      4. Windows 注册表 App Paths（HKLM / HKCU）
      5. 常见 Edge / Chrome 安装路径兜底
    """
    candidates: list[str] = []

    if explicit_path:
        p = Path(explicit_path)
        if not p.is_file():
            raise FileNotFoundError(f"指定的浏览器路径不存在：{explicit_path}")
        return p.resolve()

    env_browser = os.environ.get("NIUMA_ICON_BROWSER")
    if env_browser:
        p = Path(env_browser)
        if p.is_file():
            return p.resolve()
        raise FileNotFoundError(f"环境变量 NIUMA_ICON_BROWSER 指向的路径不存在：{env_browser}")

    # PATH 探测
    for exe_name in ("msedge", "msedge.exe", "chrome", "chrome.exe"):
        found = shutil.which(exe_name)
        if found:
            candidates.append(found)

    # Windows 注册表 App Paths 探测
    if os.name == "nt":
        for app_name in ("msedge.exe", "chrome.exe"):
            subkey = rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{app_name}"
            for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
                try:
                    with winreg.OpenKey(hive, subkey) as key:
                        val, _ = winreg.QueryValueEx(key, None)
                        if val:
                            candidates.append(val)
                except OSError:
                    pass

    # 常见系统安装目录兜底
    pf = os.environ.get("ProgramFiles", r"C:\Program Files")
    pf86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    local_app = os.environ.get("LocalAppData", "")
    candidates.extend(
        [
            os.path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
            os.path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
            os.path.join(local_app, "Microsoft", "Edge", "Application", "msedge.exe"),
            os.path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
            os.path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
            os.path.join(local_app, "Google", "Chrome", "Application", "chrome.exe"),
        ]
    )

    for raw in candidates:
        if not raw:
            continue
        p = Path(raw.strip().strip('"'))
        if p.is_file():
            return p.resolve()

    raise FileNotFoundError(
        "未检测到可用的 Microsoft Edge 或 Google Chrome 浏览器。\n"
        "请通过 --browser <浏览器可执行文件路径> 或环境变量 NIUMA_ICON_BROWSER 指定 Chromium 内核浏览器。"
    )


class CDPClient:
    """
    基于 Python 标准库 socket 实现的轻量级 RFC6455 WebSocket 客户端，用于驱动 CDP。

    特性：
      - 支持客户端随机 4 字节掩码发送文本帧；
      - 支持 7-bit / 16-bit (126) / 64-bit (127) 帧长度解析；
      - 支持多帧分片重组（fin=0 / continuation opcode=0）；
      - 自动响应服务端 Ping (0x9) -> Pong (0xA)。
    """

    _WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    def __init__(self, ws_url: str, timeout: float = 15.0) -> None:
        parsed = urllib.parse.urlparse(ws_url)
        if parsed.scheme != "ws":
            raise ValueError(f"不支持的 WebSocket URL 协议：{ws_url}")
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or 80
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"

        self._sock = socket.create_connection((host, port), timeout=timeout)
        self._sock.settimeout(timeout)
        self._buf = bytearray()
        self._next_id = 1
        self._handshake(host, port, path)

    def _handshake(self, host: str, port: int, path: str) -> None:
        """发送 HTTP/1.1 WebSocket Upgrade 握手并校验响应。"""
        raw_key = os.urandom(16)
        sec_key = base64.b64encode(raw_key).decode("ascii")
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {sec_key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        )
        self._sock.sendall(request.encode("ascii"))

        # 读取完整 HTTP 响应头，并将头部之后粘包的数据保留在 self._buf 中
        while b"\r\n\r\n" not in self._buf:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise ConnectionError("WebSocket 握手失败：连接被对端关闭")
            self._buf.extend(chunk)

        sep = bytes(self._buf).index(b"\r\n\r\n") + 4
        header_bytes = bytes(self._buf[:sep])
        del self._buf[:sep]

        header_text = header_bytes.decode("latin1")
        lines = header_text.split("\r\n")
        if not lines or " 101 " not in lines[0]:
            raise ConnectionError(f"WebSocket 握手被拒绝：{lines[0] if lines else '空响应'}")

        headers: dict[str, str] = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()

        expected_accept = base64.b64encode(
            hashlib.sha1((sec_key + self._WS_GUID).encode("ascii")).digest()
        ).decode("ascii")
        if headers.get("sec-websocket-accept") != expected_accept:
            raise ConnectionError("WebSocket 握手校验失败：Sec-WebSocket-Accept 不匹配")

    def _read_exact(self, n: int) -> bytes:
        """从缓冲区与 socket 中精确读取 n 个字节。"""
        while len(self._buf) < n:
            chunk = self._sock.recv(max(4096, n - len(self._buf)))
            if not chunk:
                raise ConnectionError("WebSocket 读取帧时连接意外断开")
            self._buf.extend(chunk)
        data = bytes(self._buf[:n])
        del self._buf[:n]
        return data

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        """按照 RFC6455 客户端要求发送带 4 字节掩码的帧。"""
        mask_key = os.urandom(4)
        length = len(payload)
        header = bytearray([0x80 | (opcode & 0x0F)])
        if length < 126:
            header.append(0x80 | length)
        elif length <= 0xFFFF:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        header.extend(mask_key)

        masked = bytes(b ^ mask_key[i & 3] for i, b in enumerate(payload))
        self._sock.sendall(bytes(header) + masked)

    def _recv_message(self) -> str:
        """读取并重组一条完整的 WebSocket 文本消息。"""
        fragments: list[bytes] = []
        expect_continuation = False

        while True:
            b1, b2 = self._read_exact(2)
            fin = (b1 & 0x80) != 0
            opcode = b1 & 0x0F
            masked = (b2 & 0x80) != 0
            length = b2 & 0x7F

            if length == 126:
                (length,) = struct.unpack("!H", self._read_exact(2))
            elif length == 127:
                (length,) = struct.unpack("!Q", self._read_exact(8))

            mask_key = self._read_exact(4) if masked else b""
            payload = self._read_exact(length)
            if masked:
                payload = bytes(b ^ mask_key[i & 3] for i, b in enumerate(payload))

            # 控制帧可能穿插在分片数据帧之间，先就地处理
            if opcode == 0x9:  # Ping -> 自动回复 Pong
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:  # Pong -> 忽略
                continue
            if opcode == 0x8:  # Close
                raise ConnectionError("服务端主动关闭了 WebSocket 连接")

            if opcode in (0x1, 0x2):  # 文本帧或二进制帧起始
                fragments = [payload]
                expect_continuation = not fin
            elif opcode == 0x0:  # 分片续传帧
                if not expect_continuation:
                    raise ProtocolError("收到意外的 WebSocket Continuation 帧")
                fragments.append(payload)
                expect_continuation = not fin
            else:
                raise ConnectionError(f"未知的 WebSocket 操作码：{opcode}")

            if fin and not expect_continuation:
                return b"".join(fragments).decode("utf-8")

    def call(
        self,
        method: str,
        params: Optional[dict[str, Any]] = None,
        wait_event: Optional[str] = None,
        timeout: float = 15.0,
    ) -> dict[str, Any]:
        """
        在当前单一 WebSocket 会话中发送 CDP 指令并等待对应响应；
        若指定 wait_event，则同时等待目标事件触发后再返回。
        """
        req_id = self._next_id
        self._next_id += 1
        message = json.dumps({"id": req_id, "method": method, "params": params or {}})
        self._send_frame(0x1, message.encode("utf-8"))

        deadline = time.monotonic() + timeout
        result_payload: Optional[dict[str, Any]] = None
        seen_event = wait_event is None

        while result_payload is None or not seen_event:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"CDP 调用 {method} 超时（wait_event={wait_event}）")
            self._sock.settimeout(remaining)
            raw = self._recv_message()
            msg = json.loads(raw)

            if msg.get("id") == req_id:
                if "error" in msg:
                    raise RuntimeError(f"CDP 调用 {method} 返回错误：{msg['error']}")
                result_payload = msg.get("result", {})
            elif wait_event and msg.get("method") == wait_event:
                seen_event = True

        return result_payload

    def close(self) -> None:
        """关闭 WebSocket 连接与底层 socket。"""
        try:
            self._send_frame(0x8, b"")
        except Exception:
            pass
        try:
            self._sock.close()
        except Exception:
            pass

    def __enter__(self) -> "CDPClient":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()


class ProtocolError(RuntimeError):
    """WebSocket 协议异常。"""


def _wait_for_cdp_ws_url(user_data_dir: Path, timeout: float = 15.0) -> str:
    """轮询 DevToolsActivePort 并请求 /json/list 获取 page 目标的 WebSocket 调试地址。"""
    port_file = user_data_dir / "DevToolsActivePort"
    deadline = time.monotonic() + timeout
    port: Optional[int] = None

    while time.monotonic() < deadline:
        if port_file.is_file():
            content = port_file.read_text(encoding="utf-8", errors="ignore").splitlines()
            if content and content[0].strip().isdigit():
                port = int(content[0].strip())
                break
        time.sleep(0.05)

    if port is None:
        raise TimeoutError(f"等待浏览器创建 DevToolsActivePort 超时：{port_file}")

    list_url = f"http://127.0.0.1:{port}/json/list"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(list_url, timeout=2.0) as resp:
                targets = json.loads(resp.read().decode("utf-8"))
            for target in targets:
                if target.get("type") == "page" and target.get("webSocketDebuggerUrl"):
                    return str(target["webSocketDebuggerUrl"])
        except Exception:
            pass
        time.sleep(0.05)

    raise TimeoutError(f"等待 CDP 页面调试目标就绪超时：{list_url}")


def render_svg_to_rgba_1024(svg_path: Path, browser_path: Path, image_cls: Any) -> Any:
    """
    通过无头 Chromium 单一 CDP 会话将 SVG 渲染为 1024×1024 真透明 RGBA 图像。
    注意：所有 Emulation 覆盖与 Page.captureScreenshot 必须在同一 WebSocket 会话内完成，
    否则断开重连会导致 Chromium 重置透明背景与视口尺寸覆盖。
    """
    if not svg_path.is_file():
        raise FileNotFoundError(f"未找到 SVG 源文件：{svg_path}")

    svg_uri = svg_path.resolve().as_uri()

    with tempfile.TemporaryDirectory(prefix="niuma_cdp_") as tmpdir:
        tmp_path = Path(tmpdir)
        cmd = [
            str(browser_path),
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--remote-debugging-port=0",
            f"--user-data-dir={tmp_path}",
            "about:blank",
        ]
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            ws_url = _wait_for_cdp_ws_url(tmp_path, timeout=15.0)
            with CDPClient(ws_url, timeout=15.0) as cdp:
                cdp.call("Page.enable")
                cdp.call(
                    "Emulation.setDeviceMetricsOverride",
                    {
                        "width": 1024,
                        "height": 1024,
                        "deviceScaleFactor": 1,
                        "mobile": False,
                    },
                )
                cdp.call(
                    "Emulation.setDefaultBackgroundColorOverride",
                    {"color": {"r": 0, "g": 0, "b": 0, "a": 0}},
                )
                cdp.call(
                    "Page.navigate",
                    {"url": svg_uri},
                    wait_event="Page.loadEventFired",
                    timeout=15.0,
                )
                shot = cdp.call(
                    "Page.captureScreenshot",
                    {
                        "format": "png",
                        "omitBackground": True,
                        "fromSurface": True,
                        "clip": {
                            "x": 0,
                            "y": 0,
                            "width": 1024,
                            "height": 1024,
                            "scale": 1,
                        },
                    },
                    timeout=15.0,
                )
        finally:
            # 务必先终止浏览器进程再离开 TemporaryDirectory，避免 Windows 报文件占用错误
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)

    png_bytes = base64.b64decode(shot["data"])
    master = image_cls.open(io.BytesIO(png_bytes))
    master.load()
    if master.size != (1024, 1024):
        raise AssertionError(f"主图尺寸异常：期望 (1024, 1024)，实际 {master.size}")
    if master.mode != "RGBA":
        master = master.convert("RGBA")
    return master


def build_windows_assets(
    master: Any,
    out_dir: Path,
    crop_box: tuple[int, int, int, int],
    image_cls: Any,
) -> None:
    """
    基于 1024×1024 RGBA 主图使用 Image.Resampling.LANCZOS 生成全部 Windows 图标文件。
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    lanczos = image_cls.Resampling.LANCZOS

    # 1. icon.png (256×256)
    icon_256 = master.resize((256, 256), lanczos)
    icon_256.save(out_dir / "icon.png", format="PNG", optimize=True)

    # 2. icon.ico（显式 LANCZOS 生成全部 7 种分辨率并打包）
    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    ico_frames = [master.resize(sz, lanczos) for sz in ico_sizes]
    ico_frames[-1].save(
        out_dir / "icon.ico",
        format="ICO",
        append_images=ico_frames[:-1],
        sizes=ico_sizes,
    )

    # 3. 托盘专用对称裁切（默认 80,80,944,944：无损圆角 + 四角全透明 + 提升小尺寸清晰度）
    cropped = master.crop(crop_box)
    tray_32 = cropped.resize((32, 32), lanczos)
    tray_32.save(out_dir / "tray@2x.png", format="PNG", optimize=True)

    tray_16 = cropped.resize((16, 16), lanczos)
    tray_16.save(out_dir / "tray.png", format="PNG", optimize=True)


def verify_assets(out_dir: Path, image_cls: Any, master: Any = None) -> None:
    """
    自动校验生成图标的分辨率、ICO 内嵌尺寸表、四角透明通道、橙色渐变方向、
    额头金币金色及牛脸非黑非白像素特征。
    """
    required_files = ["icon.ico", "icon.png", "tray.png", "tray@2x.png"]
    for name in required_files:
        p = out_dir / name
        if not p.is_file() or p.stat().st_size == 0:
            raise AssertionError(f"缺少目标图标或文件为空：{p}")

    # 0. 可选校验 1024×1024 原图
    if master is not None:
        assert master.size == (1024, 1024), f"master 尺寸错误：{master.size}"
        for pt in [(0, 0), (1023, 0), (0, 1023), (1023, 1023)]:
            assert master.getpixel(pt)[3] == 0, f"master 角点 {pt} Alpha 非 0：{master.getpixel(pt)}"
        m_top = master.getpixel((512, 102))
        m_bot = master.getpixel((512, 922))
        m_coin = master.getpixel((485, 410))
        m_face = master.getpixel((400, 580))
        assert m_top[0] > m_bot[0] and m_top[0] > 235 and m_bot[0] > 180, (
            f"master 橙色渐变异常：top={m_top}, bot={m_bot}"
        )
        assert m_coin[0] > 230 and m_coin[1] > 175 and m_coin[2] < 95, f"master 金币色彩异常：{m_coin}"
        assert m_face[0] > 245 and m_face[1] > 235 and m_face[2] > 220, f"master 牛脸色彩异常：{m_face}"
        print(
            f"[校验] 1024×1024 原图通过：top={m_top}, bot={m_bot}, coin={m_coin}, face={m_face}"
        )

    # 1. icon.ico 多分辨率结构校验
    expected_ico_sizes = {(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)}
    with image_cls.open(out_dir / "icon.ico") as ico_img:
        actual_sizes = set(ico_img.info.get("sizes", set()))
        assert actual_sizes == expected_ico_sizes, (
            f"icon.ico 内嵌尺寸不完整：期望 {sorted(expected_ico_sizes)}，实际 {sorted(actual_sizes)}"
        )
        # 逐帧解码验证每一分辨率均非纯黑且具备透明边缘
        for sz in sorted(expected_ico_sizes):
            ico_img.size = sz
            frame = ico_img.convert("RGBA")
            assert frame.size == sz, f"icon.ico 帧 {sz} 读取尺寸不匹配：{frame.size}"
            assert frame.getpixel((0, 0))[3] == 0, f"icon.ico 帧 {sz} 左上角不透明"
    print(f"[校验] icon.ico 通过：包含全部 7 种尺寸 {sorted(expected_ico_sizes)}")

    # 2. icon.png (256×256) 校验
    with image_cls.open(out_dir / "icon.png") as im256:
        assert im256.size == (256, 256) and im256.mode == "RGBA", f"icon.png 规格错误：{im256.size} {im256.mode}"
        for pt in [(0, 0), (255, 0), (0, 255), (255, 255)]:
            px = im256.getpixel(pt)
            assert px == (0, 0, 0, 0), f"icon.png 四角 {pt} 应全透明，实际 {px}"
        top = im256.getpixel((128, 30))
        bot = im256.getpixel((128, 225))
        coin = im256.getpixel((121, 102))
        face = im256.getpixel((100, 145))
        shadow = im256.getpixel((128, 234))

        assert top[3] == 255 and top[0] > 235 and 120 < top[1] < 155 and 45 < top[2] < 75, f"icon.png 顶部橙色异常：{top}"
        assert bot[3] == 255 and bot[0] > 180 and 50 < bot[1] < 80 and bot[2] < 30 and top[0] > bot[0], (
            f"icon.png 底部橙色渐变异常：top={top}, bot={bot}"
        )
        assert coin[3] == 255 and coin[0] > 230 and coin[1] > 175 and coin[2] < 95, f"icon.png 金币金色异常：{coin}"
        assert face[3] == 255 and face[0] > 245 and face[1] > 235 and face[2] > 220, f"icon.png 牛脸米白异常：{face}"
        assert 0 < shadow[3] < 100, f"icon.png 底部阴影丢失或过重：{shadow}"
        print(
            f"[校验] icon.png (256×256) 通过：top={top}, bot={bot}, coin={coin}, face={face}, shadow={shadow}"
        )

    # 3. tray@2x.png (32×32) 校验
    with image_cls.open(out_dir / "tray@2x.png") as im32:
        assert im32.size == (32, 32) and im32.mode == "RGBA", f"tray@2x.png 规格错误：{im32.size} {im32.mode}"
        for pt in [(0, 0), (31, 0), (0, 31), (31, 31)]:
            assert im32.getpixel(pt)[3] == 0, f"tray@2x.png 四角 {pt} Alpha 非 0：{im32.getpixel(pt)}"
        t_top = im32.getpixel((16, 2))
        t_bot = im32.getpixel((16, 29))
        t_coin = im32.getpixel((16, 12))
        t_face = im32.getpixel((12, 18))

        assert t_top[3] >= 250 and t_bot[3] >= 250 and t_top[0] > t_bot[0], (
            f"tray@2x.png 橙色渐变异常：top={t_top}, bot={t_bot}"
        )
        assert t_face[3] == 255 and t_face[0] > 220 and t_face[1] > 190 and t_face[2] > 160, (
            f"tray@2x.png 牛脸像素异常：{t_face}"
        )
        assert t_face[:3] not in ((0, 0, 0), (255, 255, 255)), f"tray@2x.png 牛脸退化为纯黑/纯白：{t_face}"
        assert t_coin[3] == 255 and t_coin[0] > 140 and t_coin[0] > t_coin[1] > t_coin[2], (
            f"tray@2x.png 金币像素异常：{t_coin}"
        )
        print(
            f"[校验] tray@2x.png (32×32) 通过：top={t_top}, bot={t_bot}, coin={t_coin}, face={t_face}"
        )

    # 4. tray.png (16×16) 校验
    with image_cls.open(out_dir / "tray.png") as im16:
        assert im16.size == (16, 16) and im16.mode == "RGBA", f"tray.png 规格错误：{im16.size} {im16.mode}"
        for pt in [(0, 0), (15, 0), (0, 15), (15, 15)]:
            assert im16.getpixel(pt)[3] == 0, f"tray.png 四角 {pt} Alpha 非 0：{im16.getpixel(pt)}"
        s_top = im16.getpixel((8, 1))
        s_bot = im16.getpixel((8, 14))
        s_coin = im16.getpixel((8, 6))
        s_face = im16.getpixel((6, 9))

        assert s_top[3] == 255 and s_bot[3] == 255 and s_top[0] > s_bot[0], (
            f"tray.png 橙色渐变异常：top={s_top}, bot={s_bot}"
        )
        assert s_coin[3] == 255 and s_coin[0] > 170 and s_coin[1] > 100 and s_coin[2] < 100, (
            f"tray.png 金币像素异常：{s_coin}"
        )
        assert s_face[3] == 255 and s_face[0] > 220 and s_face[1] > 180 and s_face[2] > 130, (
            f"tray.png 牛脸像素异常：{s_face}"
        )
        assert s_face[:3] not in ((0, 0, 0), (255, 255, 255)), f"tray.png 牛脸退化为纯黑/纯白：{s_face}"
        print(
            f"[校验] tray.png (16×16) 通过：top={s_top}, bot={s_bot}, coin={s_coin}, face={s_face}"
        )


def _parse_crop_box(raw: str) -> tuple[int, int, int, int]:
    """解析形如 '80,80,944,944' 的四元组裁切区域。"""
    parts = [p.strip() for p in raw.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("--tray-crop 必须包含 4 个逗号分隔整数，例如 80,80,944,944")
    try:
        left, top, right, bottom = (int(x) for x in parts)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"--tray-crop 参数含非整数：{raw}") from exc
    if not (0 <= left < right <= 1024 and 0 <= top < bottom <= 1024):
        raise argparse.ArgumentTypeError(f"--tray-crop 范围必须在 0..1024 且满足 left<right, top<bottom：{raw}")
    return (left, top, right, bottom)


def main() -> int:
    # 确保未安装 Pillow 时自动重执行到 conda tempTools
    image_cls = ensure_pillow_or_reexec()

    script_path = Path(__file__).resolve()
    repo_root = script_path.parent.parent.parent
    default_svg = repo_root / "Assets" / "AppIcon.svg"
    default_out = repo_root / "windows" / "assets"

    parser = argparse.ArgumentParser(description="从 Assets/AppIcon.svg 生成牛马加油器 Windows 图标资产")
    parser.add_argument("--svg", type=Path, default=default_svg, help="SVG 源文件路径")
    parser.add_argument("--out-dir", type=Path, default=default_out, help="图标输出目录")
    parser.add_argument("--browser", type=str, default=None, help="指定 Edge/Chrome 可执行文件路径")
    parser.add_argument(
        "--tray-crop",
        type=_parse_crop_box,
        default=(80, 80, 944, 944),
        help="托盘图标裁切框（left,top,right,bottom，默认 80,80,944,944）",
    )
    parser.add_argument("--verify-only", action="store_true", help="仅校验现有图标产物，不重新生成")
    parser.add_argument("--_reexeced", action="store_true", help=argparse.SUPPRESS)

    args = parser.parse_args()

    if args.verify_only:
        print(f"[仅校验] 检查图标目录：{args.out_dir}")
        verify_assets(args.out_dir, image_cls=image_cls, master=None)
        print("[完成] 全部图标资产校验通过。")
        return 0

    browser_path = find_chromium_browser(args.browser)
    version = _get_windows_file_version(browser_path) or "未知版本"
    print(f"[浏览器] 命中 Chromium 内核：{browser_path}（版本 {version}）")
    print(f"[渲染] SVG 源文件：{args.svg}")

    master = render_svg_to_rgba_1024(args.svg, browser_path, image_cls=image_cls)
    build_windows_assets(master, args.out_dir, args.tray_crop, image_cls=image_cls)
    verify_assets(args.out_dir, image_cls=image_cls, master=master)

    print(f"[完成] 已生成并校验全部 4 个 Windows 图标资产，输出目录：{args.out_dir}")
    for fname in ("icon.ico", "icon.png", "tray.png", "tray@2x.png"):
        fpath = args.out_dir / fname
        print(f"  - {fpath} ({fpath.stat().st_size} 字节)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
