using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle("牛马加油器")]
[assembly: AssemblyProduct("牛马加油器")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace NiumaBooster
{
    internal static class Program
    {
        private static Mutex _mutex;
        public static uint WM_SHOW_PANEL;

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        private static extern uint RegisterWindowMessage(string lpString);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool SetDllDirectory(string lpPathName);

        private static readonly string RuntimeCacheDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "NiumaBooster",
            "runtime-1.0.0"
        );

        [STAThread]
        private static void Main(string[] args)
        {
            SetProcessDPIAware();
            WM_SHOW_PANEL = RegisterWindowMessage("WM_NIUMA_BOOSTER_SHOW_PANEL");

            bool createdNew;
            _mutex = new Mutex(true, @"Local\NiumaBooster_SingleInstance_Mutex", out createdNew);
            if (!createdNew)
            {
                PostMessage((IntPtr)0xFFFF, WM_SHOW_PANEL, IntPtr.Zero, IntPtr.Zero);
                return;
            }

            Directory.CreateDirectory(RuntimeCacheDir);
            ExtractEmbeddedResource("WebView2Loader.dll", Path.Combine(RuntimeCacheDir, "WebView2Loader.dll"));
            SetDllDirectory(RuntimeCacheDir);

            AppDomain.CurrentDomain.AssemblyResolve += OnResolveAssembly;

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            RunApp(args);
            GC.KeepAlive(_mutex);
        }

        private static void RunApp(string[] args)
        {
            Application.Run(new HostApplicationContext(RuntimeCacheDir, args));
        }

        private static Assembly OnResolveAssembly(object sender, ResolveEventArgs args)
        {
            string shortName = new AssemblyName(args.Name).Name + ".dll";
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(shortName))
            {
                if (s == null) return null;
                byte[] data = new byte[s.Length];
                s.Read(data, 0, data.Length);
                return Assembly.Load(data);
            }
        }

        public static void ExtractEmbeddedResource(string resourceName, string destPath)
        {
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName))
            {
                if (s == null) return;
                byte[] data = new byte[s.Length];
                s.Read(data, 0, data.Length);
                try
                {
                    File.WriteAllBytes(destPath, data);
                }
                catch
                {
                }
            }
        }

        public static string ReadEmbeddedText(string resourceName)
        {
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName))
            {
                if (s == null) return "";
                using (StreamReader sr = new StreamReader(s, Encoding.UTF8))
                {
                    return sr.ReadToEnd();
                }
            }
        }
    }

    internal sealed class BorderlessWindow : Form
    {
        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= 0x00000080;
                return cp;
            }
        }
    }

    internal sealed class HostApplicationContext : ApplicationContext
    {
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateRoundRectRgn(int x1, int y1, int x2, int y2, int cx, int cy);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteObject(IntPtr hObject);

        private double GetDpiScale()
        {
            try
            {
                using (Graphics g = Graphics.FromHwnd(IntPtr.Zero))
                {
                    double s = g.DpiX / 96.0;
                    return s > 0.5 ? s : 1.0;
                }
            }
            catch
            {
                return 1.0;
            }
        }

        private int ScalePx(int cssPx)
        {
            return (int)Math.Ceiling(cssPx * GetDpiScale());
        }

        private static void ApplyRoundedCorners(Form form, int radiusPx)
        {
            if (form == null || form.IsDisposed || form.Width <= 0 || form.Height <= 0) return;
            IntPtr hRgn = IntPtr.Zero;
            try
            {
                hRgn = CreateRoundRectRgn(0, 0, form.Width + 1, form.Height + 1, radiusPx, radiusPx);
                Region oldRgn = form.Region;
                form.Region = Region.FromHrgn(hRgn);
                if (oldRgn != null) oldRgn.Dispose();
            }
            catch
            {
            }
            finally
            {
                if (hRgn != IntPtr.Zero) DeleteObject(hRgn);
            }
        }

        private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        private const uint SWP_NOACTIVATE = 0x0010;
        private const uint SWP_SHOWWINDOW = 0x0040;

        private const int HOTKEY_ID = 0x4E4D;
        private const uint MOD_ALT = 0x0001;
        private const uint MOD_CONTROL = 0x0002;
        private const uint MOD_NOREPEAT = 0x4000;
        private const int WM_HOTKEY = 0x0312;

        private readonly string _runtimeDir;
        private readonly string _webDir;
        private readonly string _userDataDir;
        private readonly string _settingsFilePath;
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer { MaxJsonLength = 10 * 1024 * 1024 };

        private Icon _appIcon;
        private NotifyIcon _tray;
        private ToolStripMenuItem _bossMenuItem;

        private CoreWebView2Environment _wvEnv;
        private string _coreBundleScript;
        private string _bridgeScript;
        private string _controllerScript;

        private MessageWindow _msgWindow;
        private BorderlessWindow _miniBarForm;
        private WebView2 _miniBarWebView;
        private bool _miniBarReady;

        private BorderlessWindow _panelForm;
        private WebView2 _panelWebView;
        private bool _panelReady;

        private Form _settingsForm;
        private WebView2 _settingsWebView;
        private bool _settingsReady;
        private string _pendingSettingsTab = "salary";

        private int _panelWidth = 330;
        private int _panelHeight = 490;
        private int _miniBarWidth = 128;
        private int _miniBarHeight = 34;
        private Point? _miniBarCustomPos;
        private long _lastPanelDeactivateTicks;

        private string _currentHotkeyPreset = "ctrlOptB";
        private bool _hotkeyRegistered;
        private string _hotkeyWarning;
        private Dictionary<string, object> _latestState;

        private int _reqSeq = 1;
        private readonly Dictionary<int, Action<object>> _pendingControllerReplies = new Dictionary<int, Action<object>>();

        public HostApplicationContext(string runtimeDir, string[] args)
        {
            _runtimeDir = runtimeDir;
            _webDir = Path.Combine(_runtimeDir, "web");
            Directory.CreateDirectory(_webDir);

            _userDataDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "牛马加油器"
            );
            Directory.CreateDirectory(_userDataDir);
            _settingsFilePath = Path.Combine(_userDataDir, "settings.json");

            ExtractWebAssets();
            LoadScripts();

            _msgWindow = new MessageWindow(this);
            InitTray();

            SystemEvents.PowerModeChanged += OnPowerModeChanged;
            SystemEvents.TimeChanged += OnTimeChanged;

            Task unused = InitWebViewEnvironmentAsync(args);
        }

        private void ExtractWebAssets()
        {
            string[] files = new string[]
            {
                "panel.html", "panel.css", "panel.js",
                "settings.html", "settings.css", "settings.js",
                "minibar.html", "minibar.css", "minibar.js",
                "icon.ico", "icon.png", "tray.png", "tray@2x.png"
            };
            foreach (string f in files)
            {
                Program.ExtractEmbeddedResource(f, Path.Combine(_webDir, f));
            }
        }

        private void LoadScripts()
        {
            _coreBundleScript = Program.ReadEmbeddedText("core-bundle.js");
            _bridgeScript = Program.ReadEmbeddedText("bridge.js");
            _controllerScript = Program.ReadEmbeddedText("controller.js");
        }

        private void InitTray()
        {
            string icoPath = Path.Combine(_webDir, "icon.ico");
            _appIcon = File.Exists(icoPath) ? new Icon(icoPath) : SystemIcons.Application;

            ContextMenuStrip menu = new ContextMenuStrip();
            _bossMenuItem = new ToolStripMenuItem("老板模式（Ctrl+Alt+B）") { CheckOnClick = false };
            _bossMenuItem.Click += (s, e) => SendControllerCommand("boss:toggle", null, null);

            ToolStripMenuItem openPanelItem = new ToolStripMenuItem("打开主面板");
            openPanelItem.Click += (s, e) => ShowPanel();

            ToolStripMenuItem openSettingsItem = new ToolStripMenuItem("设置…");
            openSettingsItem.Click += (s, e) => OpenSettings("salary");

            ToolStripMenuItem quitItem = new ToolStripMenuItem("退出牛马加油器");
            quitItem.Click += (s, e) => QuitApp();

            menu.Items.Add(_bossMenuItem);
            menu.Items.Add(openPanelItem);
            menu.Items.Add(openSettingsItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(quitItem);

            _tray = new NotifyIcon
            {
                Icon = _appIcon,
                Text = "牛马加油器（点击打开面板）",
                ContextMenuStrip = menu,
                Visible = true
            };

            _tray.MouseClick += (s, e) =>
            {
                if (e.Button == MouseButtons.Left)
                {
                    TogglePanel();
                }
            };
        }

        private async Task InitWebViewEnvironmentAsync(string[] args)
        {
            string wvDataDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "NiumaBooster",
                "webview2-data"
            );
            Directory.CreateDirectory(wvDataDir);

            CoreWebView2EnvironmentOptions opts = new CoreWebView2EnvironmentOptions("--disable-gpu");
            _wvEnv = await CoreWebView2Environment.CreateAsync(null, wvDataDir, opts);

            await EnsureMiniBarWindowAsync();
            await EnsurePanelWindowAsync();

            if (args != null && Array.IndexOf(args, "--show") >= 0)
            {
                ShowPanel();
            }
        }

        private Dictionary<string, object> LoadPersistedSettings()
        {
            try
            {
                if (File.Exists(_settingsFilePath))
                {
                    string raw = File.ReadAllText(_settingsFilePath, Encoding.UTF8).TrimStart('\uFEFF');
                    Dictionary<string, object> obj = _json.DeserializeObject(raw) as Dictionary<string, object>;
                    if (obj != null) return obj;
                }
            }
            catch
            {
            }
            return new Dictionary<string, object>();
        }

        private void SavePersistedSettings(object settingsObj)
        {
            if (settingsObj == null) return;
            try
            {
                string jsonStr = _json.Serialize(settingsObj);
                string tmpPath = _settingsFilePath + ".tmp";
                File.WriteAllText(tmpPath, jsonStr, new UTF8Encoding(false));
                if (File.Exists(_settingsFilePath))
                {
                    File.Delete(_settingsFilePath);
                }
                File.Move(tmpPath, _settingsFilePath);
            }
            catch
            {
            }
        }

        public void ApplyBossHotkey(string preset)
        {
            _currentHotkeyPreset = string.IsNullOrEmpty(preset) ? "ctrlOptB" : preset;
            UnregisterHotKey(_msgWindow.Handle, HOTKEY_ID);

            if (_currentHotkeyPreset == "off")
            {
                _hotkeyRegistered = false;
                _hotkeyWarning = null;
                return;
            }

            uint vk = _currentHotkeyPreset == "ctrlOptCmdH" ? (uint)Keys.H : (uint)Keys.B;
            string label = _currentHotkeyPreset == "ctrlOptCmdH" ? "Ctrl+Alt+H" : "Ctrl+Alt+B";
            bool ok = RegisterHotKey(_msgWindow.Handle, HOTKEY_ID, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, vk);
            _hotkeyRegistered = ok;
            _hotkeyWarning = ok ? null : ("快捷键 " + label + " 已被其他程序占用，可在设置中切换或关闭。");
        }

        private bool IsLoginItemEnabled()
        {
            try
            {
                using (RegistryKey rk = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", false))
                {
                    if (rk == null) return false;
                    object val = rk.GetValue("NiumaBooster");
                    return val != null && !string.IsNullOrEmpty(val.ToString());
                }
            }
            catch
            {
                return false;
            }
        }

        private string SetLoginItem(bool enabled)
        {
            try
            {
                using (RegistryKey rk = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
                {
                    if (rk == null) return "设置失败：无法访问注册表自启项";
                    if (enabled)
                    {
                        rk.SetValue("NiumaBooster", "\"" + Application.ExecutablePath + "\"");
                    }
                    else
                    {
                        rk.DeleteValue("NiumaBooster", false);
                    }
                }
                return null;
            }
            catch (Exception ex)
            {
                return "设置失败：" + ex.Message;
            }
        }

        private async Task EnsureMiniBarWindowAsync()
        {
            if (_miniBarForm != null && !_miniBarForm.IsDisposed) return;

            Dictionary<string, object> initialSettings = LoadPersistedSettings();
            string hkPreset = initialSettings.ContainsKey("bossHotkey") && initialSettings["bossHotkey"] != null
                ? initialSettings["bossHotkey"].ToString()
                : "ctrlOptB";
            ApplyBossHotkey(hkPreset);

            _miniBarForm = new BorderlessWindow
            {
                FormBorderStyle = FormBorderStyle.None,
                ShowInTaskbar = false,
                StartPosition = FormStartPosition.Manual,
                TopMost = true,
                BackColor = Color.FromArgb(30, 30, 34),
                Size = new Size(ScalePx(_miniBarWidth), ScalePx(_miniBarHeight)),
                Icon = _appIcon
            };
            PositionMiniBar();

            _miniBarWebView = new WebView2
            {
                Dock = DockStyle.Fill,
                DefaultBackgroundColor = Color.Transparent
            };
            _miniBarForm.Controls.Add(_miniBarWebView);

            await _miniBarWebView.EnsureCoreWebView2Async(_wvEnv);
            ConfigureWebView(_miniBarWebView);

            var initPayload = new Dictionary<string, object>
            {
                { "settings", initialSettings },
                { "openAtLogin", IsLoginItemEnabled() },
                { "hotkeyRegistered", _hotkeyRegistered },
                { "hotkeyWarning", _hotkeyWarning }
            };
            string initScript =
                "window.__NIUMA_IS_CONTROLLER__ = true;\n" +
                "window.__NIUMA_HOST_INIT__ = " + _json.Serialize(initPayload) + ";\n" +
                _coreBundleScript + "\n" +
                _bridgeScript + "\n" +
                _controllerScript;

            await _miniBarWebView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(initScript);
            _miniBarWebView.CoreWebView2.Navigate("https://niuma.local/minibar.html");
            _miniBarReady = true;
        }

        private async Task EnsurePanelWindowAsync()
        {
            if (_panelForm != null && !_panelForm.IsDisposed) return;

            _panelForm = new BorderlessWindow
            {
                FormBorderStyle = FormBorderStyle.None,
                ShowInTaskbar = false,
                StartPosition = FormStartPosition.Manual,
                TopMost = true,
                BackColor = Color.White,
                Size = new Size(ScalePx(_panelWidth), ScalePx(_panelHeight)),
                Icon = _appIcon
            };

            _panelForm.Deactivate += (s, e) =>
            {
                if (_panelForm != null && _panelForm.Visible)
                {
                    _lastPanelDeactivateTicks = Environment.TickCount;
                    _panelForm.Hide();
                }
            };

            _panelWebView = new WebView2
            {
                Dock = DockStyle.Fill
            };
            _panelForm.Controls.Add(_panelWebView);

            await _panelWebView.EnsureCoreWebView2Async(_wvEnv);
            ConfigureWebView(_panelWebView);

            string initStateJson = _latestState != null ? _json.Serialize(_latestState) : "null";
            await _panelWebView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                "window.__NIUMA_INITIAL_STATE__ = " + initStateJson + ";\n" + _bridgeScript
            );
            _panelWebView.CoreWebView2.NavigationCompleted += (s, e) =>
            {
                _panelReady = true;
                if (_latestState != null)
                {
                    PostStateToWebView(_panelWebView, _latestState);
                }
            };
            _panelWebView.CoreWebView2.Navigate("https://niuma.local/panel.html");
        }

        private async Task EnsureSettingsWindowAsync(string tab)
        {
            _pendingSettingsTab = string.IsNullOrEmpty(tab) ? "salary" : tab;

            if (_panelForm != null && _panelForm.Visible)
            {
                _panelForm.Hide();
            }

            if (_settingsForm != null && !_settingsForm.IsDisposed)
            {
                if (_settingsForm.WindowState == FormWindowState.Minimized)
                {
                    _settingsForm.WindowState = FormWindowState.Normal;
                }
                _settingsForm.Show();
                _settingsForm.Activate();
                SendControllerCommand("selectTab", _pendingSettingsTab, null);
                return;
            }

            _settingsForm = new Form
            {
                Text = "牛马加油器 — 设置",
                Size = new Size(ScalePx(740), ScalePx(700)),
                MinimumSize = new Size(ScalePx(660), ScalePx(560)),
                StartPosition = FormStartPosition.CenterScreen,
                Icon = _appIcon
            };

            _settingsForm.FormClosing += (s, e) =>
            {
                if (e.CloseReason == CloseReason.UserClosing)
                {
                    e.Cancel = true;
                    _settingsForm.Hide();
                }
            };

            _settingsWebView = new WebView2
            {
                Dock = DockStyle.Fill
            };
            _settingsForm.Controls.Add(_settingsWebView);
            _settingsForm.Show();

            await _settingsWebView.EnsureCoreWebView2Async(_wvEnv);
            ConfigureWebView(_settingsWebView);

            string initStateJson = _latestState != null ? _json.Serialize(_latestState) : "null";
            await _settingsWebView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                "window.__NIUMA_INITIAL_STATE__ = " + initStateJson + ";\n" + _bridgeScript
            );
            _settingsWebView.CoreWebView2.NavigationCompleted += (s, e) =>
            {
                _settingsReady = true;
                SendControllerCommand("selectTab", _pendingSettingsTab, null);
                if (_latestState != null)
                {
                    PostStateToWebView(_settingsWebView, _latestState);
                }
            };
            _settingsWebView.CoreWebView2.Navigate("https://niuma.local/settings.html?tab=" + Uri.EscapeDataString(_pendingSettingsTab));
        }

        private void ConfigureWebView(WebView2 wv)
        {
            wv.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            wv.CoreWebView2.Settings.AreDevToolsEnabled = false;
            wv.CoreWebView2.Settings.IsStatusBarEnabled = false;
            wv.CoreWebView2.Settings.IsZoomControlEnabled = false;
            wv.CoreWebView2.SetVirtualHostNameToFolderMapping(
                "niuma.local",
                _webDir,
                CoreWebView2HostResourceAccessKind.Allow
            );
            wv.CoreWebView2.WebMessageReceived += (s, e) =>
            {
                OnWebMessageReceived(wv, e.TryGetWebMessageAsString());
            };
        }

        private void OnWebMessageReceived(WebView2 sender, string rawJson)
        {
            if (string.IsNullOrEmpty(rawJson)) return;
            Dictionary<string, object> msg;
            try
            {
                msg = _json.DeserializeObject(rawJson) as Dictionary<string, object>;
            }
            catch
            {
                return;
            }
            if (msg == null || !msg.ContainsKey("type")) return;

            string type = Convert.ToString(msg["type"]);
            if (type == "controller:sync")
            {
                HandleControllerSync(msg);
                return;
            }

            if (type == "controller:reply" && msg.ContainsKey("reqId"))
            {
                int reqId = Convert.ToInt32(msg["reqId"]);
                Action<object> cb;
                if (_pendingControllerReplies.TryGetValue(reqId, out cb))
                {
                    _pendingControllerReplies.Remove(reqId);
                    object res = msg.ContainsKey("result") ? msg["result"] : null;
                    cb(res);
                }
                return;
            }

            if (type == "ipc:invoke")
            {
                int callId = msg.ContainsKey("id") ? Convert.ToInt32(msg["id"]) : 0;
                string channel = msg.ContainsKey("channel") ? Convert.ToString(msg["channel"]) : "";
                object payload = msg.ContainsKey("payload") ? msg["payload"] : null;
                HandleIpcInvoke(sender, callId, channel, payload);
            }
        }

        private void HandleControllerSync(Dictionary<string, object> msg)
        {
            if (msg.ContainsKey("state"))
            {
                Dictionary<string, object> st = msg["state"] as Dictionary<string, object>;
                if (st != null)
                {
                    _latestState = st;
                    if (_panelReady && _panelWebView != null && !_panelWebView.IsDisposed)
                    {
                        PostStateToWebView(_panelWebView, st);
                    }
                    if (_settingsReady && _settingsWebView != null && !_settingsWebView.IsDisposed)
                    {
                        PostStateToWebView(_settingsWebView, st);
                    }
                }
            }

            if (msg.ContainsKey("saveSettings") && msg["saveSettings"] != null)
            {
                SavePersistedSettings(msg["saveSettings"]);
            }

            if (msg.ContainsKey("bossHotkey") && msg["bossHotkey"] != null)
            {
                string nextHk = Convert.ToString(msg["bossHotkey"]);
                if (nextHk != _currentHotkeyPreset)
                {
                    ApplyBossHotkey(nextHk);
                    SendControllerCommand("hotkeyStatus", new Dictionary<string, object>
                    {
                        { "registered", _hotkeyRegistered },
                        { "warning", _hotkeyWarning }
                    }, null);
                }
            }

            if (_bossMenuItem != null)
            {
                if (msg.ContainsKey("bossMenuLabel") && msg["bossMenuLabel"] != null)
                {
                    _bossMenuItem.Text = Convert.ToString(msg["bossMenuLabel"]);
                }
                if (msg.ContainsKey("boss"))
                {
                    _bossMenuItem.Checked = Convert.ToBoolean(msg["boss"]);
                }
            }

            if (_tray != null && msg.ContainsKey("tooltip") && msg["tooltip"] != null)
            {
                string tip = Convert.ToString(msg["tooltip"]);
                if (tip.Length > 63) tip = tip.Substring(0, 62) + "…";
                if (_tray.Text != tip)
                {
                    try { _tray.Text = tip; } catch { }
                }
            }

            if (msg.ContainsKey("shouldShowMiniBar") && _miniBarForm != null && !_miniBarForm.IsDisposed)
            {
                bool show = Convert.ToBoolean(msg["shouldShowMiniBar"]);
                if (show && !_miniBarForm.Visible)
                {
                    PositionMiniBar();
                    SetWindowPos(
                        _miniBarForm.Handle,
                        HWND_TOPMOST,
                        _miniBarForm.Left,
                        _miniBarForm.Top,
                        _miniBarForm.Width,
                        _miniBarForm.Height,
                        SWP_NOACTIVATE | SWP_SHOWWINDOW
                    );
                    _miniBarForm.Visible = true;
                }
                else if (!show && _miniBarForm.Visible)
                {
                    _miniBarForm.Hide();
                }
            }

            if (msg.ContainsKey("notifications") && _tray != null)
            {
                object[] notifs = msg["notifications"] as object[];
                if (notifs != null)
                {
                    foreach (object item in notifs)
                    {
                        Dictionary<string, object> n = item as Dictionary<string, object>;
                        if (n != null)
                        {
                            string title = n.ContainsKey("title") ? Convert.ToString(n["title"]) : "牛马加油器";
                            string body = n.ContainsKey("body") ? Convert.ToString(n["body"]) : "";
                            if (!string.IsNullOrEmpty(body))
                            {
                                _tray.ShowBalloonTip(4000, title, body, ToolTipIcon.None);
                            }
                        }
                    }
                }
            }
        }

        private void HandleIpcInvoke(WebView2 sender, int callId, string channel, object payload)
        {
            if (channel == "panel:resize")
            {
                object res = HandleResizeOrMiniBar(payload);
                ReplyIpc(sender, callId, res);
                return;
            }
            if (channel == "window:openSettings")
            {
                string tab = payload != null ? Convert.ToString(payload) : "salary";
                OpenSettings(tab);
                ReplyIpc(sender, callId, new Dictionary<string, object> { { "ok", true }, { "tab", tab } });
                return;
            }
            if (channel == "window:hidePanel")
            {
                if (_panelForm != null && _panelForm.Visible) _panelForm.Hide();
                ReplyIpc(sender, callId, new Dictionary<string, object> { { "ok", true } });
                return;
            }
            if (channel == "app:quit")
            {
                ReplyIpc(sender, callId, new Dictionary<string, object> { { "ok", true } });
                QuitApp();
                return;
            }
            if (channel == "loginItem:set")
            {
                bool flag = payload != null && Convert.ToBoolean(payload);
                string err = SetLoginItem(flag);
                bool cur = IsLoginItemEnabled();
                SendControllerCommand("loginStatus", new Dictionary<string, object>
                {
                    { "openAtLogin", cur },
                    { "error", err }
                }, (res) => ReplyIpc(sender, callId, res));
                return;
            }
            if (channel == "holidays:importDialog")
            {
                using (OpenFileDialog dlg = new OpenFileDialog())
                {
                    dlg.Title = "导入节假日 JSON";
                    dlg.Filter = "JSON 文件 (*.json)|*.json|所有文件 (*.*)|*.*";
                    dlg.Multiselect = false;
                    if (dlg.ShowDialog() != DialogResult.OK || string.IsNullOrEmpty(dlg.FileName))
                    {
                        ReplyIpc(sender, callId, new Dictionary<string, object>
                        {
                            { "ok", true },
                            { "canceled", true },
                            { "importedCount", 0 },
                            { "message", "" }
                        });
                        return;
                    }
                    try
                    {
                        string rawText = File.ReadAllText(dlg.FileName, Encoding.UTF8);
                        SendControllerCommand("holidays:importRaw", rawText, (res) => ReplyIpc(sender, callId, res));
                    }
                    catch (Exception ex)
                    {
                        ReplyIpc(sender, callId, new Dictionary<string, object>
                        {
                            { "ok", false },
                            { "canceled", false },
                            { "message", "导入失败：文件不是正确的格式。" },
                            { "error", ex.Message }
                        });
                    }
                }
                return;
            }

            SendControllerCommand(channel, payload, (res) => ReplyIpc(sender, callId, res));
        }

        private object HandleResizeOrMiniBar(object payload)
        {
            Dictionary<string, object> dict = payload as Dictionary<string, object>;
            if (dict != null)
            {
                if (dict.ContainsKey("width"))
                {
                    Dictionary<string, object> inner = dict["width"] as Dictionary<string, object>;
                    if (inner != null)
                    {
                        dict = inner;
                    }
                }
                if (dict.ContainsKey("target") && Convert.ToString(dict["target"]) == "minibar")
                {
                    string action = dict.ContainsKey("action") ? Convert.ToString(dict["action"]) : "resize";
                    if (action == "resize")
                    {
                        if (dict.ContainsKey("width") && dict["width"] != null)
                        {
                            _miniBarWidth = Math.Max(48, Math.Min(420, Convert.ToInt32(dict["width"])));
                        }
                        if (dict.ContainsKey("height") && dict["height"] != null)
                        {
                            _miniBarHeight = Math.Max(30, Math.Min(64, Convert.ToInt32(dict["height"])));
                        }
                        PositionMiniBar();
                    }
                    else if (action == "moveBy" && _miniBarForm != null)
                    {
                        int dx = dict.ContainsKey("dx") ? ScalePx(Convert.ToInt32(dict["dx"])) : 0;
                        int dy = dict.ContainsKey("dy") ? ScalePx(Convert.ToInt32(dict["dy"])) : 0;
                        _miniBarCustomPos = new Point(_miniBarForm.Left + dx, _miniBarForm.Top + dy);
                        PositionMiniBar();
                    }
                    else if (action == "togglePanel")
                    {
                        TogglePanel();
                    }
                    return new Dictionary<string, object> { { "ok", true } };
                }

                if (dict.ContainsKey("width") && dict["width"] != null)
                {
                    _panelWidth = Math.Max(280, Math.Min(600, Convert.ToInt32(dict["width"])));
                }
                if (dict.ContainsKey("height") && dict["height"] != null)
                {
                    _panelHeight = Math.Max(180, Math.Min(900, Convert.ToInt32(dict["height"])));
                }
                PositionPanel();
            }
            return new Dictionary<string, object>
            {
                { "ok", true },
                { "width", _panelWidth },
                { "height", _panelHeight }
            };
        }

        private void PositionMiniBar()
        {
            if (_miniBarForm == null || _miniBarForm.IsDisposed) return;
            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            int w = ScalePx(_miniBarWidth);
            int h = ScalePx(_miniBarHeight);
            int padRight = ScalePx(16);
            int padBottom = ScalePx(6);
            int minPad = ScalePx(4);
            int x = _miniBarCustomPos.HasValue ? _miniBarCustomPos.Value.X : (wa.Right - w - padRight);
            int y = _miniBarCustomPos.HasValue ? _miniBarCustomPos.Value.Y : (wa.Bottom - h - padBottom);
            x = Math.Max(wa.Left + minPad, Math.Min(x, wa.Right - w - minPad));
            y = Math.Max(wa.Top + minPad, Math.Min(y, wa.Bottom - h - minPad));
            _miniBarForm.Bounds = new Rectangle(x, y, w, h);
            ApplyRoundedCorners(_miniBarForm, h);
        }

        private void PositionPanel()
        {
            if (_panelForm == null || _panelForm.IsDisposed) return;
            Point anchor = Cursor.Position;
            if (_miniBarForm != null && _miniBarForm.Visible)
            {
                anchor = new Point(_miniBarForm.Left + _miniBarForm.Width / 2, _miniBarForm.Top);
            }
            Screen scr = Screen.FromPoint(anchor);
            Rectangle wa = scr.WorkingArea;
            int gap = ScalePx(8);
            int w = Math.Min(ScalePx(_panelWidth), wa.Width - gap * 2);
            int h = Math.Min(ScalePx(_panelHeight), wa.Height - gap * 2);
            int x = anchor.X - w / 2;
            int y = (_miniBarForm != null && _miniBarForm.Visible)
                ? (_miniBarForm.Top - h - gap)
                : (wa.Bottom - h - gap);
            x = Math.Max(wa.Left + gap, Math.Min(x, wa.Right - w - gap));
            y = Math.Max(wa.Top + gap, Math.Min(y, wa.Bottom - h - gap));
            _panelForm.Bounds = new Rectangle(x, y, w, h);
            ApplyRoundedCorners(_panelForm, ScalePx(20));
        }

        public void ShowPanel()
        {
            if (_panelForm == null || _panelForm.IsDisposed) return;
            PositionPanel();
            _panelForm.Show();
            _panelForm.Activate();
        }

        public void TogglePanel()
        {
            if (_panelForm == null || _panelForm.IsDisposed) return;
            if (_panelForm.Visible)
            {
                _panelForm.Hide();
                return;
            }
            if (Math.Abs(Environment.TickCount - _lastPanelDeactivateTicks) < 220)
            {
                return;
            }
            ShowPanel();
        }

        public void OpenSettings(string tab)
        {
            Task unused = EnsureSettingsWindowAsync(tab);
        }

        private void SendControllerCommand(string action, object arg, Action<object> callback)
        {
            if (!_miniBarReady || _miniBarWebView == null || _miniBarWebView.CoreWebView2 == null)
            {
                if (callback != null) callback(_latestState);
                return;
            }
            int reqId = 0;
            if (callback != null)
            {
                reqId = _reqSeq++;
                _pendingControllerReplies[reqId] = callback;
            }
            var msg = new Dictionary<string, object>
            {
                { "type", "controller:command" },
                { "action", action },
                { "arg", arg },
                { "reqId", reqId }
            };
            _miniBarWebView.CoreWebView2.PostWebMessageAsString(_json.Serialize(msg));
        }

        private void PostStateToWebView(WebView2 wv, object state)
        {
            if (wv == null || wv.IsDisposed || wv.CoreWebView2 == null) return;
            var msg = new Dictionary<string, object>
            {
                { "type", "state:update" },
                { "state", state }
            };
            try
            {
                wv.CoreWebView2.PostWebMessageAsString(_json.Serialize(msg));
            }
            catch
            {
            }
        }

        private void ReplyIpc(WebView2 wv, int id, object result)
        {
            if (id <= 0 || wv == null || wv.IsDisposed || wv.CoreWebView2 == null) return;
            var msg = new Dictionary<string, object>
            {
                { "type", "ipc:reply" },
                { "id", id },
                { "result", result }
            };
            try
            {
                wv.CoreWebView2.PostWebMessageAsString(_json.Serialize(msg));
            }
            catch
            {
            }
        }

        private void OnPowerModeChanged(object sender, PowerModeChangedEventArgs e)
        {
            if (e.Mode == PowerModes.Resume)
            {
                SendControllerCommand("realign", null, null);
            }
        }

        private void OnTimeChanged(object sender, EventArgs e)
        {
            SendControllerCommand("realign", null, null);
        }

        public void OnHotKeyPressed()
        {
            SendControllerCommand("boss:toggle", null, null);
        }

        public void QuitApp()
        {
            SystemEvents.PowerModeChanged -= OnPowerModeChanged;
            SystemEvents.TimeChanged -= OnTimeChanged;
            if (_msgWindow != null)
            {
                UnregisterHotKey(_msgWindow.Handle, HOTKEY_ID);
                _msgWindow.DestroyHandle();
            }
            if (_tray != null)
            {
                _tray.Visible = false;
                _tray.Dispose();
            }
            Application.Exit();
        }

        private sealed class MessageWindow : NativeWindow
        {
            private readonly HostApplicationContext _ctx;

            public MessageWindow(HostApplicationContext ctx)
            {
                _ctx = ctx;
                CreateHandle(new CreateParams());
            }

            protected override void WndProc(ref Message m)
            {
                if (m.Msg == WM_HOTKEY && m.WParam.ToInt32() == HOTKEY_ID)
                {
                    _ctx.OnHotKeyPressed();
                    return;
                }
                if (Program.WM_SHOW_PANEL != 0 && (uint)m.Msg == Program.WM_SHOW_PANEL)
                {
                    _ctx.ShowPanel();
                    return;
                }
                base.WndProc(ref m);
            }
        }
    }
}
