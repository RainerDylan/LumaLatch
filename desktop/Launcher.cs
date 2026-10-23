using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace LumaLatch
{
    internal sealed class Settings
    {
        public string Ip { get; set; }
        public int Port { get; set; }
        public string JellyfinUrl { get; set; }
    }

    internal static class Launcher
    {
        internal const string PreferredIp = "100.76.133.88";
        internal const string DefaultJellyfin = "http://100.76.133.88:8096";
        internal const int DefaultPort = 8787;
        internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        [STAThread]
        private static int Main(string[] args)
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--root" && i + 1 < args.Length) root = Path.GetFullPath(args[++i]);
            }
            try
            {
                if (args.Contains("--self-test")) return SelfTest(root);
                if (args.Contains("--smoke-test")) return SmokeTest(root).GetAwaiter().GetResult();
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                if (args.Contains("--ui-smoke-test"))
                {
                    using (MainForm form = new MainForm(root, true))
                    {
                        form.Show();
                        form.PerformLayout();
                        form.Controls[0].PerformLayout();
                        Application.DoEvents();
                        using (Bitmap bitmap = new Bitmap(form.Width, form.Height))
                        {
                            form.DrawToBitmap(bitmap, new Rectangle(0, 0, bitmap.Width, bitmap.Height));
                            bitmap.Save(Path.Combine(root, "ui-smoke.png"));
                        }
                    }
                    return 0;
                }
                Application.Run(new MainForm(root, false));
                return 0;
            }
            catch (Exception error)
            {
                if (args.Any(a => a.EndsWith("-test", StringComparison.Ordinal))) Console.Error.WriteLine(error);
                else MessageBox.Show(error.Message, "LumaLatch", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        internal static string ExtensionId(string manifestPath)
        {
            Dictionary<string, object> manifest = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(manifestPath));
            object value;
            if (!manifest.TryGetValue("key", out value) || !(value is string)) throw new InvalidDataException("extension/manifest.json has no public key.");
            byte[] key = Convert.FromBase64String((string)value);
            if (key.Length == 0) throw new InvalidDataException("The extension public key is empty.");
            byte[] hash;
            using (SHA256 sha = SHA256.Create()) hash = sha.ComputeHash(key);
            StringBuilder id = new StringBuilder(32);
            for (int i = 0; i < 16; i++)
            {
                id.Append((char)('a' + (hash[i] >> 4)));
                id.Append((char)('a' + (hash[i] & 15)));
            }
            return id.ToString();
        }

        internal static bool IsTailscaleIp(string text)
        {
            IPAddress ip;
            if (!IPAddress.TryParse(text, out ip) || ip.AddressFamily != AddressFamily.InterNetwork) return false;
            byte[] b = ip.GetAddressBytes();
            return b[0] == 100 && b[1] >= 64 && b[1] <= 127;
        }

        internal static List<string> AssignedIps()
        {
            List<string> addresses = new List<string>();
            foreach (NetworkInterface adapter in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (adapter.OperationalStatus != OperationalStatus.Up) continue;
                foreach (UnicastIPAddressInformation entry in adapter.GetIPProperties().UnicastAddresses)
                {
                    string ip = entry.Address.ToString();
                    if (IsTailscaleIp(ip) && !addresses.Contains(ip)) addresses.Add(ip);
                }
            }
            addresses.Sort(StringComparer.Ordinal);
            if (addresses.Remove(PreferredIp)) addresses.Insert(0, PreferredIp);
            return addresses;
        }

        internal static int ValidPort(string value)
        {
            int port;
            if (!int.TryParse(value, out port) || port < 1 || port > 65535) throw new ArgumentException("Port must be 1–65535.");
            return port;
        }

        internal static string ValidJellyfin(string value)
        {
            Uri uri;
            if (!Uri.TryCreate(value, UriKind.Absolute, out uri) || (uri.Scheme != "http" && uri.Scheme != "https") ||
                String.IsNullOrEmpty(uri.Host) || !String.IsNullOrEmpty(uri.UserInfo))
                throw new ArgumentException("Jellyfin URL must be an http:// or https:// address without credentials.");
            return uri.AbsoluteUri.TrimEnd('/');
        }

        internal static string Quote(string argument)
        {
            // Windows CreateProcess quoting, including spaces, quotes and trailing backslashes.
            StringBuilder result = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in argument)
            {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); slashes = 0; continue; }
                result.Append('\\', slashes); slashes = 0; result.Append(c);
            }
            result.Append('\\', slashes * 2); result.Append('"');
            return result.ToString();
        }

        internal static void CheckPackage(string root)
        {
            foreach (string item in new[] { "runtime/node.exe", "app/package.json", "app/server/index.js", "app/node_modules/ws", "extension/manifest.json", "START-HERE.html", "Quick-Start.pdf" })
            {
                string path = Path.Combine(root, item.Replace('/', Path.DirectorySeparatorChar));
                if (!File.Exists(path) && !Directory.Exists(path)) throw new FileNotFoundException("Missing package item: " + item + ". Extract the entire ZIP first.");
            }
        }

        internal static Settings ReadSettings(string root)
        {
            string path = Path.Combine(root, "settings.json");
            if (!File.Exists(path)) return new Settings { Ip = PreferredIp, Port = DefaultPort, JellyfinUrl = DefaultJellyfin };
            Settings value = Json.Deserialize<Settings>(File.ReadAllText(path));
            if (value == null) throw new InvalidDataException("settings.json is empty.");
            if (!IsTailscaleIp(value.Ip)) throw new InvalidDataException("settings.json has an invalid Tailscale IP.");
            ValidPort(value.Port.ToString());
            ValidJellyfin(value.JellyfinUrl);
            return value;
        }

        internal static void SaveSettings(string root, Settings value)
        {
            string path = Path.Combine(root, "settings.json");
            string temp = Path.Combine(root, ".settings-" + Guid.NewGuid().ToString("N") + ".tmp");
            try
            {
                using (FileStream stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                using (StreamWriter writer = new StreamWriter(stream, new UTF8Encoding(false)))
                {
                    writer.Write(Json.Serialize(value));
                    writer.Flush();
                    stream.Flush(true);
                }
                if (File.Exists(path)) File.Replace(temp, path, null);
                else File.Move(temp, path);
            }
            finally { if (File.Exists(temp)) File.Delete(temp); }
        }

        internal static Process StartChild(string root, string ip, int port, string id, Action<string> log)
        {
            ProcessStartInfo info = new ProcessStartInfo(Path.Combine(root, "runtime", "node.exe"), Quote(Path.Combine(root, "app", "server", "index.js")));
            info.WorkingDirectory = root;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardInput = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.EnvironmentVariables.Remove("NODE_OPTIONS");
            info.EnvironmentVariables.Remove("NODE_PATH");
            info.EnvironmentVariables["TAILSCALE_IP"] = ip;
            info.EnvironmentVariables["PORT"] = port.ToString();
            info.EnvironmentVariables["JELLYFIN_ORIGINS"] = "chrome-extension://" + id;
            Process child = new Process();
            child.StartInfo = info;
            child.EnableRaisingEvents = true;
            child.OutputDataReceived += (sender, e) => { if (e.Data != null) log(e.Data); };
            child.ErrorDataReceived += (sender, e) => { if (e.Data != null) log("ERROR: " + e.Data); };
            try { child.Start(); child.BeginOutputReadLine(); child.BeginErrorReadLine(); return child; }
            catch { child.Dispose(); throw; }
        }

        internal static async Task WaitForHealth(Process child, string ip, int port, Func<bool> announced, Action<string> log)
        {
            Uri address = new Uri("http://" + ip + ":" + port + "/health");
            DateTime deadline = DateTime.UtcNow.AddSeconds(8);
            using (HttpClientHandler handler = new HttpClientHandler { UseProxy = false })
            using (HttpClient client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(1) })
            {
                while (DateTime.UtcNow < deadline)
                {
                    if (child.HasExited) throw new InvalidOperationException("Server exited before health check; see log (exit " + child.ExitCode + ").");
                    if (announced())
                    {
                        try
                        {
                            string body = await client.GetStringAsync(address);
                            Dictionary<string, object> health = Json.Deserialize<Dictionary<string, object>>(body);
                            object ok;
                            if (health != null && health.TryGetValue("ok", out ok) && ok is bool && (bool)ok) return;
                            log("Health response was not ok: " + body);
                        }
                        catch (Exception error) { log("Waiting for server: " + error.Message); }
                    }
                    await Task.Delay(200);
                }
            }
            throw new TimeoutException("Server did not report healthy within 8 seconds; see log.");
        }

        internal static async Task StopChild(Process child)
        {
            if (child == null) return;
            try
            {
                if (!child.HasExited)
                {
                    try { await child.StandardInput.WriteLineAsync("stop"); child.StandardInput.Flush(); }
                    catch (IOException) { }
                    bool exited = await Task.Run(() => child.WaitForExit(4000));
                    if (!exited && !child.HasExited) { child.Kill(); await Task.Run(() => child.WaitForExit()); }
                }
            }
            finally { child.Dispose(); }
        }

        private static int SelfTest(string root)
        {
            string id = ExtensionId(Path.Combine(root, "extension", "manifest.json"));
            if (id.Length != 32 || id.Any(c => c < 'a' || c > 'p')) throw new Exception("Extension ID calculation failed.");
            if (!Quote("a b\\").Equals("\"a b\\\\\"") || !Quote("a\"b").Equals("\"a\\\"b\"")) throw new Exception("Path quoting failed.");
            if (!IsTailscaleIp(PreferredIp) || IsTailscaleIp("100.128.0.1") || IsTailscaleIp("127.0.0.1")) throw new Exception("IP validation failed.");
            if (ValidPort("8787") != DefaultPort || ValidJellyfin(DefaultJellyfin) != DefaultJellyfin) throw new Exception("Defaults failed.");
            try { ValidPort("0"); throw new Exception("Port validation failed."); } catch (ArgumentException) { }
            try { ValidJellyfin("file:///bad"); throw new Exception("URL validation failed."); } catch (ArgumentException) { }
            Console.WriteLine("Self-test passed. Extension ID: " + id);
            return 0;
        }

        private static async Task<int> SmokeTest(string root)
        {
            CheckPackage(root);
            List<string> ips = AssignedIps();
            if (ips.Count == 0) throw new InvalidOperationException("Connect Tailscale: no assigned 100.64.0.0/10 IPv4 address.");
            string ip = ips[0];
            int port;
            TcpListener reservation = new TcpListener(IPAddress.Parse(ip), 0);
            reservation.Start();
            try { port = ((IPEndPoint)reservation.LocalEndpoint).Port; }
            finally { reservation.Stop(); }
            TaskCompletionSource<bool> announcement = new TaskCompletionSource<bool>();
            Process child = StartChild(root, ip, port, ExtensionId(Path.Combine(root, "extension", "manifest.json")), line =>
            {
                if (line.StartsWith("LumaLatch listening at ", StringComparison.Ordinal)) announcement.TrySetResult(true);
                Console.WriteLine(line);
            });
            Exception failure = null;
            try
            {
                await WaitForHealth(child, ip, port, () => announcement.Task.IsCompleted, Console.WriteLine);
                Console.WriteLine("Smoke-test health passed at " + ip + ":" + port);
            }
            catch (Exception error) { failure = error; }
            await StopChild(child);
            if (failure != null) throw failure;
            return 0;
        }
    }

    internal sealed class MainForm : Form
    {
        private readonly string root;
        private readonly ComboBox ip = new ComboBox();
        private readonly TextBox port = new TextBox();
        private readonly TextBox jellyfin = new TextBox();
        private readonly TextBox log = new TextBox();
        private readonly Label status = new Label();
        private Button start = new Button();
        private Button stop = new Button();
        private Process child;
        private string activeAddress;
        private bool closing;
        private string chrome;

        internal MainForm(string packageRoot, bool testMode)
        {
            root = packageRoot;
            Text = "LumaLatch — Host setup";
            Width = 850; Height = 740; MinimumSize = new Size(680, 600);
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Font;
            Font = new Font(SystemFonts.MessageBoxFont.FontFamily, 10f);
            BuildUi();
            try
            {
                Settings saved = Launcher.ReadSettings(root);
                port.Text = saved.Port.ToString(); jellyfin.Text = saved.JellyfinUrl;
                RefreshReadiness(saved.Ip);
            }
            catch (Exception error) { port.Text = Launcher.DefaultPort.ToString(); jellyfin.Text = Launcher.DefaultJellyfin; SetStatus(error.Message, true); }
            if (!testMode) Append("Guests need only the extension and Tailscale. Keep this host window open during the party.");
        }

        private void BuildUi()
        {
            TableLayoutPanel layout = new TableLayoutPanel();
            layout.Dock = DockStyle.Fill; layout.AutoScroll = true; layout.Padding = new Padding(16);
            layout.ColumnCount = 1; layout.RowCount = 0;
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            Controls.Add(layout);
            AddHeading(layout, "1. Install Chrome and Tailscale");
            AddButtons(layout, Button("Get Google Chrome", () => OpenUrl("https://www.google.com/chrome/")),
                Button("Get Tailscale", () => OpenUrl("https://tailscale.com/download/windows")));
            AddHeading(layout, "2. Connect Tailscale on this host");
            AddRow(layout, "Assigned Tailscale IPv4", ip);
            ip.DropDownStyle = ComboBoxStyle.DropDownList;
            AddButtons(layout, Button("Recheck readiness", () => RefreshReadiness(ip.SelectedItem as string)));
            AddHeading(layout, "3. Load the Chrome extension");
            AddText(layout, "In Chrome, enable Developer mode at chrome://extensions, choose Load unpacked, then select the extension folder. The extension ID is calculated from its included public key.");
            AddButtons(layout, Button("Open Chrome extensions", OpenExtensions), Button("Copy extension folder path", () => Copy(Path.Combine(root, "extension"))), Button("Open extension folder", () => OpenFile(Path.Combine(root, "extension"))));
            AddHeading(layout, "4. Start your private signaling server");
            AddRow(layout, "Port", port);
            AddButtons(layout, start = Button("Start server", async () => await StartServer()), stop = Button("Stop server", async () => await StopServer()));
            stop.Enabled = false;
            AddButtons(layout, Button("Copy signaling address", CopyAddress));
            AddHeading(layout, "5. Open Jellyfin and invite friends");
            AddRow(layout, "Jellyfin URL", jellyfin);
            AddButtons(layout, Button("Open Jellyfin in Chrome", OpenJellyfin), Button("Open Quick Start PDF", () => OpenFile(Path.Combine(root, "Quick-Start.pdf"))), Button("Open START-HERE", () => OpenFile(Path.Combine(root, "START-HERE.html"))));
            status.AutoSize = true; status.Padding = new Padding(0, 8, 0, 8); status.Text = "Checking readiness…";
            layout.Controls.Add(status);
            AddHeading(layout, "Status and error log");
            log.Multiline = true; log.ReadOnly = true; log.ScrollBars = ScrollBars.Vertical; log.Height = 130; log.Dock = DockStyle.Top;
            log.AccessibleName = "Status and error log";
            layout.Controls.Add(log);
        }

        private static Button Button(string label, Action action)
        {
            Button button = new Button(); button.Text = label; button.AutoSize = true; button.MinimumSize = new Size(130, 32);
            button.Click += (sender, args) => { try { action(); } catch (Exception error) { MessageBox.Show(error.Message, "LumaLatch", MessageBoxButtons.OK, MessageBoxIcon.Error); } };
            return button;
        }

        private void AddHeading(TableLayoutPanel parent, string title)
        {
            Label heading = new Label(); heading.Text = title; heading.Font = new Font(Font, FontStyle.Bold);
            heading.AutoSize = true; heading.Padding = new Padding(0, 8, 0, 3);
            parent.Controls.Add(heading);
        }

        private static void AddText(TableLayoutPanel parent, string value)
        {
            Label label = new Label(); label.Text = value; label.AutoSize = true; label.MaximumSize = new Size(760, 0);
            parent.Controls.Add(label);
        }

        private static void AddRow(TableLayoutPanel parent, string label, Control control)
        {
            FlowLayoutPanel row = new FlowLayoutPanel(); row.AutoSize = true; row.Dock = DockStyle.Top; row.WrapContents = false;
            Label name = new Label(); name.Text = label; name.AutoSize = true; name.Margin = new Padding(0, 8, 12, 0);
            control.Width = 400; control.AccessibleName = label;
            row.Controls.Add(name); row.Controls.Add(control); parent.Controls.Add(row);
        }

        private static void AddButtons(TableLayoutPanel parent, params Button[] buttons)
        {
            FlowLayoutPanel row = new FlowLayoutPanel(); row.AutoSize = true; row.Dock = DockStyle.Top;
            foreach (Button button in buttons) row.Controls.Add(button);
            parent.Controls.Add(row);
        }

        private void SetStatus(string message, bool error)
        {
            status.Text = "Status: " + message; status.ForeColor = error ? Color.DarkRed : Color.DarkGreen; Append(message);
        }

        private void Append(string line)
        {
            if (IsDisposed) return;
            if (InvokeRequired) { PostIfOpen(() => Append(line)); return; }
            log.AppendText(DateTime.Now.ToString("HH:mm:ss") + "  " + line + Environment.NewLine);
        }

        private void PostIfOpen(Action action)
        {
            if (closing || IsDisposed || !IsHandleCreated) return;
            try { BeginInvoke(action); }
            catch (ObjectDisposedException) { if (!closing && !IsDisposed) throw; }
            catch (InvalidOperationException) { if (!closing && !IsDisposed && IsHandleCreated) throw; }
        }

        private void RefreshReadiness(string selected)
        {
            try
            {
                Launcher.CheckPackage(root);
                string id = Launcher.ExtensionId(Path.Combine(root, "extension", "manifest.json"));
                chrome = DetectChrome();
                List<string> addresses = Launcher.AssignedIps();
                ip.Items.Clear(); foreach (string address in addresses) ip.Items.Add(address);
                if (addresses.Count == 0) { SetStatus("Connect Tailscale. No assigned 100.64.0.0/10 IPv4 address found.", true); return; }
                ip.SelectedItem = addresses.Contains(selected) ? selected : addresses[0];
                SetStatus("Ready to start on " + ip.SelectedItem + ". Extension ID: " + id + (chrome == null ? ". Chrome not detected." : "."), chrome == null);
            }
            catch (Exception error) { SetStatus(error.Message, true); }
        }

        private static string DetectChrome()
        {
            foreach (string basePath in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) })
            {
                string candidate = Path.Combine(basePath, "Google", "Chrome", "Application", "chrome.exe");
                if (File.Exists(candidate)) return candidate;
            }
            return null;
        }

        private static void OpenUrl(string value) { Process.Start(new ProcessStartInfo(value) { UseShellExecute = true }); }
        private static void OpenFile(string value)
        {
            if (!File.Exists(value) && !Directory.Exists(value)) throw new FileNotFoundException("Missing: " + value);
            Process.Start(new ProcessStartInfo(value) { UseShellExecute = true });
        }
        private void OpenExtensions()
        {
            chrome = DetectChrome();
            if (chrome == null) throw new InvalidOperationException("Chrome not found. Install Chrome, then recheck readiness.");
            Process.Start(new ProcessStartInfo(chrome, "chrome://extensions") { UseShellExecute = false });
        }
        private void OpenJellyfin()
        {
            chrome = DetectChrome();
            if (chrome == null) throw new InvalidOperationException("Chrome not found. Install Chrome, then recheck readiness.");
            Process.Start(new ProcessStartInfo(chrome, Launcher.Quote(Launcher.ValidJellyfin(jellyfin.Text))) { UseShellExecute = false });
        }
        private void Copy(string value) { Clipboard.SetText(value); SetStatus("Copied: " + value, false); }
        private void CopyAddress()
        {
            if (activeAddress == null || child == null || child.HasExited) throw new InvalidOperationException("Start this host's server first.");
            Copy(activeAddress);
        }

        private async Task StartServer()
        {
            if (child != null)
            {
                if (!child.HasExited) return;
                child.Dispose();
                child = null;
            }
            activeAddress = null;
            start.Enabled = false;
            Exception failure = null;
            try
            {
                Launcher.CheckPackage(root);
                string selected = ip.SelectedItem as string;
                if (!Launcher.IsTailscaleIp(selected) || !Launcher.AssignedIps().Contains(selected)) throw new InvalidOperationException("Select an assigned Tailscale IPv4 address after rechecking readiness.");
                int number = Launcher.ValidPort(port.Text);
                string url = Launcher.ValidJellyfin(jellyfin.Text);
                string id = Launcher.ExtensionId(Path.Combine(root, "extension", "manifest.json"));
                Launcher.SaveSettings(root, new Settings { Ip = selected, Port = number, JellyfinUrl = url });
                TaskCompletionSource<bool> announcement = new TaskCompletionSource<bool>();
                child = Launcher.StartChild(root, selected, number, id, line =>
                {
                    if (line.StartsWith("LumaLatch listening at ", StringComparison.Ordinal)) announcement.TrySetResult(true);
                    Append(line);
                });
                Process owned = child;
                owned.Exited += (sender, args) =>
                {
                    PostIfOpen(() =>
                    {
                        if (child == owned && !closing) { activeAddress = null; stop.Enabled = false; start.Enabled = true; SetStatus("Server exited unexpectedly (code " + owned.ExitCode + "). See log.", true); }
                    });
                };
                SetStatus("Starting server; checking /health…", false);
                await Launcher.WaitForHealth(owned, selected, number, () => announcement.Task.IsCompleted, Append);
                if (owned.HasExited) throw new InvalidOperationException("Server exited immediately after health check; see log.");
                activeAddress = "ws://" + selected + ":" + number + "/party";
                stop.Enabled = true;
                SetStatus("Server ready at " + activeAddress, false);
            }
            catch (Exception error) { failure = error; }
            if (failure != null)
            {
                activeAddress = null;
                SetStatus("Start failed: " + failure.Message, true);
                if (child != null) { Process owned = child; child = null; await Launcher.StopChild(owned); }
                start.Enabled = true; stop.Enabled = false;
            }
        }

        private async Task StopServer()
        {
            if (child == null) return;
            stop.Enabled = false;
            activeAddress = null;
            Process owned = child; child = null;
            try { await Launcher.StopChild(owned); SetStatus("Server stopped. Party ended.", false); }
            catch (Exception error) { SetStatus("Stop failed: " + error.Message, true); }
            finally { start.Enabled = true; }
        }

        protected override async void OnFormClosing(FormClosingEventArgs e)
        {
            if (!closing && child != null && !child.HasExited)
            {
                if (MessageBox.Show("Closing LumaLatch ends the running party. Stop the server and close?", "End party?", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes)
                { e.Cancel = true; return; }
                e.Cancel = true; closing = true; Enabled = false;
                try { await StopServer(); }
                finally { Close(); }
                return;
            }
            base.OnFormClosing(e);
        }
    }
}
