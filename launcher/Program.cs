using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace StackStepperLauncher
{
    internal static class Program
    {
        private static Mutex s_mutex = null;

        [STAThread]
        private static void Main()
        {
            const string mutexName = "Global\\StackStepper_SingleInstance_Mutex_9A8B7C6D";
            bool createdNew;

            try
            {
                s_mutex = new Mutex(true, mutexName, out createdNew);
            }
            catch
            {
                createdNew = false;
            }

            if (!createdNew)
            {
                MessageBox.Show("StackStepper is already running.", "StackStepper", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            AppDomain.CurrentDomain.UnhandledException += (s, e) =>
            {
                try { File.WriteAllText("crash.log", string.Format("[{0:yyyy-MM-dd HH:mm:ss.fff}] UnhandledException: {1}", DateTime.Now, e.ExceptionObject)); } catch {}
            };

            Application.ThreadException += (s, e) =>
            {
                try { File.WriteAllText("crash.log", string.Format("[{0:yyyy-MM-dd HH:mm:ss.fff}] ThreadException: {1}", DateTime.Now, e.Exception)); } catch {}
            };

            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                using (var form = new LauncherForm())
                {
                    Application.Run(form);
                }
            }
            catch (Exception ex)
            {
                try { File.WriteAllText("crash.log", string.Format("[{0:yyyy-MM-dd HH:mm:ss.fff}] Main Catch: {1}", DateTime.Now, ex)); } catch {}
            }
            finally
            {
                if (s_mutex != null)
                {
                    try { s_mutex.ReleaseMutex(); } catch {}
                    s_mutex.Close();
                }
            }
        }
    }

    public class LauncherForm : Form
    {
        private NotifyIcon _notifyIcon;
        private ContextMenuStrip _trayMenu;
        private ToolStripMenuItem _statusItem;
        private ToolStripMenuItem _restartItem;
        private Label _statusLabel;
        private Button _btnRestart;
        private Button _btnExit;
        private Button _btnLogs;

        private LauncherManager _manager;

        public LauncherForm()
        {
            InitializeComponent();
            _manager = new LauncherManager(this);
            _manager.StartSync();
        }

        private void InitializeComponent()
        {
            this.Text = "StackStepper Launcher";
            this.Size = new Size(420, 220);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.MinimizeBox = true;

            try
            {
                this.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch { }

            _statusLabel = new Label
            {
                Text = "Starting StackStepper services...",
                Location = new Point(20, 25),
                Size = new Size(360, 40),
                Font = new Font("Segoe UI", 10F, FontStyle.Bold),
                ForeColor = Color.DarkBlue
            };
            this.Controls.Add(_statusLabel);

            _btnRestart = new Button
            {
                Text = "Restart All Services",
                Location = new Point(20, 80),
                Size = new Size(170, 35),
                Font = new Font("Segoe UI", 9F)
            };
            _btnRestart.Click += (s, e) => _manager.RestartServicesSync();
            this.Controls.Add(_btnRestart);

            _btnLogs = new Button
            {
                Text = "Open Logs Folder",
                Location = new Point(210, 80),
                Size = new Size(170, 35),
                Font = new Font("Segoe UI", 9F)
            };
            _btnLogs.Click += (s, e) => _manager.OpenLogsFolder();
            this.Controls.Add(_btnLogs);

            _btnExit = new Button
            {
                Text = "Exit & Stop StackStepper",
                Location = new Point(20, 125),
                Size = new Size(360, 35),
                Font = new Font("Segoe UI", 9F, FontStyle.Bold),
                BackColor = Color.MistyRose
            };
            _btnExit.Click += (s, e) => ConfirmAndShutdown();
            this.Controls.Add(_btnExit);

            _trayMenu = new ContextMenuStrip();
            _statusItem = new ToolStripMenuItem("Status: Starting...") { Enabled = false };
            _restartItem = new ToolStripMenuItem("Restart All Services", null, (s, e) => _manager.RestartServicesSync());

            _trayMenu.Items.Add(_statusItem);
            _trayMenu.Items.Add(new ToolStripSeparator());
            _trayMenu.Items.Add(_restartItem);
            _trayMenu.Items.Add(new ToolStripMenuItem("Open Logs Folder", null, (s, e) => _manager.OpenLogsFolder()));
            _trayMenu.Items.Add(new ToolStripSeparator());
            _trayMenu.Items.Add(new ToolStripMenuItem("Exit StackStepper", null, (s, e) => ConfirmAndShutdown()));

            _notifyIcon = new NotifyIcon
            {
                Icon = SystemIcons.Application,
                Text = "StackStepper Launcher",
                ContextMenuStrip = _trayMenu,
                Visible = true
            };
            _notifyIcon.DoubleClick += (s, e) => RestoreFromTray();

            this.FormClosing += LauncherForm_FormClosing;
        }

        private void RestoreFromTray()
        {
            this.Show();
            this.WindowState = FormWindowState.Normal;
            this.Activate();
        }

        private void LauncherForm_FormClosing(object sender, FormClosingEventArgs e)
        {
            if (e.CloseReason == CloseReason.UserClosing)
            {
                var dr = MessageBox.Show(
                    "Do you want to stop all StackStepper background services?\n\n" +
                    "- Yes: Completely exit StackStepper and stop all services.\n" +
                    "- No: Keep services running in the background tray.\n" +
                    "- Cancel: Keep launcher open.",
                    "Exit StackStepper",
                    MessageBoxButtons.YesNoCancel,
                    MessageBoxIcon.Question);

                if (dr == DialogResult.Yes)
                {
                    PerformShutdown();
                }
                else if (dr == DialogResult.No)
                {
                    e.Cancel = true;
                    this.Hide();
                    if (_notifyIcon != null)
                    {
                        _notifyIcon.ShowBalloonTip(2000, "StackStepper", "StackStepper is still running in the system tray.", ToolTipIcon.Info);
                    }
                }
                else
                {
                    e.Cancel = true;
                }
            }
            else
            {
                PerformShutdown();
            }
        }

        private void ConfirmAndShutdown()
        {
            var dr = MessageBox.Show(
                "Are you sure you want to exit StackStepper and stop all background services?",
                "Exit StackStepper",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning);

            if (dr == DialogResult.Yes)
            {
                PerformShutdown();
            }
        }

        private void PerformShutdown()
        {
            if (_notifyIcon != null) _notifyIcon.Visible = false;
            _manager.StopAllServicesAndExit();
        }

        public void SetStatusText(string text, bool isOnline)
        {
            if (this.InvokeRequired)
            {
                this.BeginInvoke(new Action(() => SetStatusText(text, isOnline)));
                return;
            }

            _statusLabel.Text = text;
            _statusLabel.ForeColor = isOnline ? Color.DarkGreen : Color.DarkBlue;
            _statusItem.Text = "Status: " + text;
        }

        public void SetControlsEnabled(bool enabled)
        {
            if (this.InvokeRequired)
            {
                this.BeginInvoke(new Action(() => SetControlsEnabled(enabled)));
                return;
            }

            _btnRestart.Enabled = enabled;
            _restartItem.Enabled = enabled;
        }
    }

    public class LauncherManager
    {
        private readonly LauncherForm _form;
        private readonly string _rootDir;
        private readonly string _localLogDir;
        private readonly string _localAppDataLogDir;

        private Process _mysqlProcess;
        private Process _sqlGatewayProcess;
        private Process _cppBackendProcess;

        private readonly object _shutdownLock = new object();
        private bool _shutdownInProgress = false;

        public LauncherManager(LauncherForm form)
        {
            _form = form;
            _rootDir = AppDomain.CurrentDomain.BaseDirectory;
            _localLogDir = Path.Combine(_rootDir, "logs");
            _localAppDataLogDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StackStepper", "logs");

            if (!Directory.Exists(_localLogDir)) Directory.CreateDirectory(_localLogDir);
            if (!Directory.Exists(_localAppDataLogDir)) Directory.CreateDirectory(_localAppDataLogDir);
        }

        private void Log(string message)
        {
            string formatted = string.Format("[{0:yyyy-MM-dd HH:mm:ss.fff}] {1}", DateTime.Now, message);
            Debug.WriteLine(formatted);

            try { File.AppendAllText(Path.Combine(_localLogDir, "launcher.log"), formatted + Environment.NewLine); } catch {}
            try { File.AppendAllText(Path.Combine(_localAppDataLogDir, "launcher.log"), formatted + Environment.NewLine); } catch {}
        }

        public void StartSync()
        {
            Task.Run(() => LaunchSequence(autoOpenBrowser: true));
        }

        private bool LaunchSequence(bool autoOpenBrowser)
        {
            try
            {
                Log("============================================================");
                Log("Starting StackStepper Desktop Launcher");
                Log("Project Root: " + _rootDir);
                Log("============================================================");

                UpdateStatus("Starting MySQL Engine...", false);
                if (!StartMySQL())
                {
                    UpdateStatus("StackStepper: MySQL Failed", false);
                    return false;
                }

                if (!WaitForPort(3307, 15000, "MySQL Engine"))
                {
                    UpdateStatus("StackStepper: MySQL Port 3307 Failed", false);
                    return false;
                }

                UpdateStatus("Starting SQL Gateway...", false);
                if (!StartSqlGateway())
                {
                    UpdateStatus("StackStepper: SQL Gateway Failed", false);
                    return false;
                }

                if (!WaitForPort(18080, 15000, "SQL Gateway"))
                {
                    UpdateStatus("StackStepper: SQL Gateway Port 18080 Failed", false);
                    return false;
                }

                UpdateStatus("Starting C++ Stepper Backend...", false);
                if (!StartCppBackend())
                {
                    UpdateStatus("StackStepper: C++ Backend Failed", false);
                    return false;
                }

                if (!WaitForPort(3000, 15000, "C++ Backend"))
                {
                    UpdateStatus("StackStepper: C++ Backend Port 3000 Failed", false);
                    return false;
                }

                UpdateStatus("StackStepper: Running (Online)", true);
                Log("[OK] All StackStepper services running and verified.");

                if (autoOpenBrowser)
                {
                    OpenBrowser();
                }

                return true;
            }
            catch (Exception ex)
            {
                Log("CRITICAL FAILURE in launch sequence: " + ex);
                UpdateStatus("StackStepper: Startup Failed (" + ex.Message + ")", false);
                StopAllChildProcessesInternal();
                return false;
            }
        }

        private bool StartMySQL()
        {
            string mysqldExe = Path.Combine(_rootDir, "mysql", "bin", "mysqld.exe");
            string myCnf = Path.Combine(_rootDir, "mysql-config", "my.cnf");

            if (!File.Exists(mysqldExe))
            {
                Log("ERROR: mysqld.exe not found at " + mysqldExe);
                MessageBox.Show("mysqld.exe not found at:\n" + mysqldExe, "StackStepper Launch Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return false;
            }

            // If the tracked process is still healthy, nothing to do.
            if (_mysqlProcess != null && !_mysqlProcess.HasExited)
            {
                Log(string.Format("MySQL is already active (PID {0}). Skipping spawn.", _mysqlProcess.Id));
                return true;
            }

            // Clean up any stale StackStepper-owned mysqld from a previous unclean exit.
            // SAFETY: Only processes confirmed as StackStepper-owned are touched.
            //         MySQL80 and every other mysqld on the machine are completely ignored.
            CleanupStaleStackStepperMysqld(mysqldExe, myCnf);

            Log("Spawning MySQL: " + mysqldExe + " --defaults-file=" + myCnf);
            _mysqlProcess = SpawnHiddenProcess(mysqldExe, "--defaults-file=\"" + myCnf + "\"", _rootDir, "mysql");
            return _mysqlProcess != null && !_mysqlProcess.HasExited;
        }

        // Returns true only when the executable path confirms this mysqld belongs to StackStepper.
        // MySQL80 exe lives in "C:\Program Files\MySQL\" — completely different path.
        // StackStepper's mysqld.exe lives inside the project folder under mysql\bin\.
        // The exe path is therefore sufficient and unique — no extra assembly references needed.
        private bool IsStackStepperOwnedMysqld(Process p, string expectedExePath, string expectedCnfPath)
        {
            if (p == null || p.HasExited) return false;
            try
            {
                string actualExe = string.Empty;
                try { actualExe = p.MainModule.FileName; } catch { return false; }

                // Exact path match — if the exe is our bundled mysqld it belongs to StackStepper.
                // Any other mysqld (MySQL80, XAMPP, etc.) will have a different path and is untouched.
                return string.Equals(actualExe, expectedExePath, StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return false;
            }
        }

        private void CleanupStaleStackStepperMysqld(string mysqldExePath, string myCnfPath)
        {
            try
            {
                var procs = Process.GetProcessesByName("mysqld");
                foreach (var p in procs)
                {
                    try
                    {
                        if (p.HasExited) continue;

                        if (!IsStackStepperOwnedMysqld(p, mysqldExePath, myCnfPath))
                        {
                            // Not StackStepper-owned (e.g. MySQL80). Leave it completely alone.
                            Log(string.Format("mysqld PID {0}: NOT StackStepper-owned. Leaving untouched.", p.Id));
                            continue;
                        }

                        Log(string.Format("Stale StackStepper mysqld detected (PID {0}). Attempting graceful shutdown...", p.Id));

                        // Try graceful mysqladmin shutdown first
                        string mysqlAdmin = Path.Combine(_rootDir, "mysql", "bin", "mysqladmin.exe");
                        bool gracefulOk = false;
                        if (File.Exists(mysqlAdmin))
                        {
                            try
                            {
                                var psi = new ProcessStartInfo
                                {
                                    FileName = mysqlAdmin,
                                    Arguments = "-h 127.0.0.1 -P 3307 -u root shutdown",
                                    UseShellExecute = false,
                                    CreateNoWindow = true
                                };
                                using (var pAdmin = Process.Start(psi))
                                {
                                    pAdmin.WaitForExit(5000);
                                }
                                gracefulOk = p.WaitForExit(5000);
                            }
                            catch { }
                        }

                        if (!gracefulOk && !p.HasExited)
                        {
                            Log(string.Format("Graceful shutdown did not complete. Force-terminating stale StackStepper mysqld PID {0}...", p.Id));
                            try { p.Kill(); p.WaitForExit(2000); } catch { }
                        }

                        if (p.HasExited)
                            Log(string.Format("Stale StackStepper mysqld PID {0} exited cleanly.", p.Id));
                        else
                            Log(string.Format("WARNING: Stale StackStepper mysqld PID {0} may still be alive.", p.Id));
                    }
                    catch (Exception ex)
                    {
                        Log(string.Format("CleanupStaleStackStepperMysqld: error processing PID {0}: {1}", p.Id, ex.Message));
                    }
                }
            }
            catch (Exception ex)
            {
                Log("CleanupStaleStackStepperMysqld: " + ex.Message);
            }
        }

        
        private string GetNodeExePath()
        {
            string bundledNode = Path.Combine(_rootDir, "runtime", "node", "node.exe");
            if (File.Exists(bundledNode)) return bundledNode;
            return "node.exe";
        }

        private bool StartSqlGateway()
        {
            string sqlDir = Path.Combine(_rootDir, "backend", "sql");
            string scriptFile = Path.Combine(sqlDir, "index.js");
            if (!File.Exists(scriptFile)) {
                sqlDir = Path.Combine(_rootDir, "backend");
                scriptFile = Path.Combine(sqlDir, "index.js");
            }

            if (!File.Exists(scriptFile))
            {
                Log("ERROR: SQL Gateway index.js not found at " + scriptFile);
                return false;
            }

            Log("Spawning SQL Gateway in " + sqlDir);
            _sqlGatewayProcess = SpawnHiddenProcess(GetNodeExePath(), "index.js", sqlDir, "sql-gateway");

            Thread.Sleep(200);
            if (_sqlGatewayProcess == null || _sqlGatewayProcess.HasExited)
            {
                int exitCode = _sqlGatewayProcess != null && _sqlGatewayProcess.HasExited ? _sqlGatewayProcess.ExitCode : -1;
                Log(string.Format("ERROR: SQL Gateway process failed immediately (ExitCode {0}).", exitCode));
                return false;
            }
            return true;
        }

        private bool StartCppBackend()
        {
            string cppDir = Path.Combine(_rootDir, "backend", "cpp");
            string scriptFile = Path.Combine(cppDir, "index.js");

            if (!File.Exists(scriptFile))
            {
                Log("ERROR: C++ Backend index.js not found at " + scriptFile);
                return false;
            }

            Log("Spawning C++ Stepper Backend in " + cppDir);
            _cppBackendProcess = SpawnHiddenProcess(GetNodeExePath(), "index.js", cppDir, "cpp-backend");

            Thread.Sleep(200);
            if (_cppBackendProcess == null || _cppBackendProcess.HasExited)
            {
                int exitCode = _cppBackendProcess != null && _cppBackendProcess.HasExited ? _cppBackendProcess.ExitCode : -1;
                Log(string.Format("ERROR: C++ Backend process failed immediately (ExitCode {0}).", exitCode));
                return false;
            }
            return true;
        }

        private Process SpawnHiddenProcess(string fileName, string arguments, string workingDirectory, string logPrefix)
        {
            try
            {
                string localLogPath = Path.Combine(_localLogDir, logPrefix + ".log");
                string appDataLogPath = Path.Combine(_localAppDataLogDir, logPrefix + ".log");

                var psi = new ProcessStartInfo
                {
                    FileName = fileName,
                    Arguments = arguments,
                    WorkingDirectory = workingDirectory,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };

                var proc = new Process { StartInfo = psi };

                proc.OutputDataReceived += (s, e) =>
                {
                    if (!string.IsNullOrEmpty(e.Data))
                    {
                        AppendToLog(localLogPath, e.Data);
                        AppendToLog(appDataLogPath, e.Data);
                    }
                };

                proc.ErrorDataReceived += (s, e) =>
                {
                    if (!string.IsNullOrEmpty(e.Data))
                    {
                        AppendToLog(localLogPath, "[ERR] " + e.Data);
                        AppendToLog(appDataLogPath, "[ERR] " + e.Data);
                    }
                };

                proc.Start();
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();

                JobObject.AddProcess(proc);

                Log(string.Format("Spawned {0} PID {1}", logPrefix, proc.Id));
                return proc;
            }
            catch (Exception ex)
            {
                Log(string.Format("Failed to spawn {0} ({1}): {2}", logPrefix, fileName, ex.Message));
                return null;
            }
        }

        private void AppendToLog(string path, string text)
        {
            try
            {
                File.AppendAllText(path, string.Format("[{0:yyyy-MM-dd HH:mm:ss.fff}] {1}", DateTime.Now, text) + Environment.NewLine);
            }
            catch { }
        }

        private bool WaitForPort(int port, int timeoutMs, string serviceName)
        {
            Log(string.Format("Waiting for {0} on port {1}...", serviceName, port));
            int elapsed = 0;
            int interval = 300;

            while (elapsed < timeoutMs)
            {
                if (_shutdownInProgress) return false;

                try
                {
                    using (var client = new TcpClient())
                    {
                        var result = client.BeginConnect("127.0.0.1", port, null, null);
                        bool success = result.AsyncWaitHandle.WaitOne(TimeSpan.FromMilliseconds(200));
                        if (success && client.Connected)
                        {
                            client.EndConnect(result);
                            Log(string.Format("[OK] {0} active on port {1}", serviceName, port));
                            return true;
                        }
                    }
                }
                catch { }

                Thread.Sleep(interval);
                elapsed += interval;
            }

            Log(string.Format("[FAIL] Timeout waiting for {0} on port {1}", serviceName, port));
            return false;
        }

        public void OpenBrowser()
        {
            try
            {
                if (_form != null && _form.InvokeRequired)
                {
                    _form.BeginInvoke(new Action(OpenBrowser));
                    return;
                }

                Log("Opening browser to http://localhost:3000");
                Process.Start(new ProcessStartInfo("http://localhost:3000") { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                Log("Failed to open browser: " + ex.Message);
            }
        }

        public void OpenLogsFolder()
        {
            try
            {
                Process.Start(new ProcessStartInfo(_localAppDataLogDir) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                Log("Failed to open logs folder: " + ex.Message);
            }
        }

        public void RestartServicesSync()
        {
            lock (_shutdownLock)
            {
                if (_shutdownInProgress) return;
            }

            Log("Restarting StackStepper services...");
            if (_form != null) _form.SetControlsEnabled(false);
            UpdateStatus("Restarting Services...", false);

            Task.Run(() =>
            {
                StopAllChildProcessesInternal();
                Thread.Sleep(500);
                bool success = LaunchSequence(autoOpenBrowser: false);
                if (_form != null) _form.SetControlsEnabled(true);
            });
        }

        private void UpdateStatus(string text, bool isOnline)
        {
            if (_form != null)
            {
                _form.SetStatusText(text, isOnline);
            }
        }

        public void StopAllServicesAndExit()
        {
            lock (_shutdownLock)
            {
                if (_shutdownInProgress) return;
                _shutdownInProgress = true;
            }

            Log("StopAllServicesAndExit initiated...");
            UpdateStatus("Stopping StackStepper...", false);

            Task.Run(() =>
            {
                StopAllChildProcessesInternal();
                Log("All child processes stopped. Exiting Application.");

                if (_form != null && !_form.IsDisposed)
                {
                    _form.BeginInvoke(new Action(() => Application.Exit()));
                }
            });
        }

        private void StopAllChildProcessesInternal()
        {
            Log("Stopping child processes...");

            // 1. Stop C++ Backend
            if (_cppBackendProcess != null)
            {
                try
                {
                    if (!_cppBackendProcess.HasExited)
                    {
                        Log(string.Format("Stopping C++ Backend (PID {0})...", _cppBackendProcess.Id));
                        _cppBackendProcess.Kill();
                        _cppBackendProcess.WaitForExit(1000);
                    }
                }
                catch (Exception ex)
                {
                    Log("Error stopping C++ Backend: " + ex.Message);
                }
                _cppBackendProcess = null;
            }

            // 2. Stop SQL Gateway
            if (_sqlGatewayProcess != null)
            {
                try
                {
                    if (!_sqlGatewayProcess.HasExited)
                    {
                        Log(string.Format("Stopping SQL Gateway (PID {0})...", _sqlGatewayProcess.Id));
                        _sqlGatewayProcess.Kill();
                        _sqlGatewayProcess.WaitForExit(1000);
                    }
                }
                catch (Exception ex)
                {
                    Log("Error stopping SQL Gateway: " + ex.Message);
                }
                _sqlGatewayProcess = null;
            }

            // 3. Graceful MySQL Shutdown
            StopMySQLGracefully();
        }

        private void StopMySQLGracefully()
        {
            if (_mysqlProcess != null)
            {
                try
                {
                    if (!_mysqlProcess.HasExited)
                    {
                        Log(string.Format("Gracefully shutting down MySQL Engine (PID {0})...", _mysqlProcess.Id));
                        string mysqlAdmin = Path.Combine(_rootDir, "mysql", "bin", "mysqladmin.exe");

                        if (File.Exists(mysqlAdmin))
                        {
                            var psi = new ProcessStartInfo
                            {
                                FileName = mysqlAdmin,
                                Arguments = "-h 127.0.0.1 -P 3307 -u root shutdown",
                                UseShellExecute = false,
                                CreateNoWindow = true
                            };
                            using (var pAdmin = Process.Start(psi))
                            {
                                pAdmin.WaitForExit(5000);
                            }
                        }

                        if (!_mysqlProcess.WaitForExit(3000))
                        {
                            Log("MySQL did not exit after graceful shutdown request. Terminating...");
                            _mysqlProcess.Kill();
                            _mysqlProcess.WaitForExit(1000);
                        }
                        else
                        {
                            Log("MySQL shut down gracefully.");
                        }
                    }
                }
                catch (Exception ex)
                {
                    Log("Error during MySQL graceful shutdown: " + ex.Message);
                }
                _mysqlProcess = null;
            }
        }
    }

    internal static class JobObject
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        private const int JOBOBJECT_EXTENDED_LIMIT_INFORMATION = 9;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION_STRUCT
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public IntPtr ProcessMemoryLimit;
            public IntPtr JobMemoryLimit;
            public IntPtr PeakProcessMemoryUsed;
            public IntPtr PeakJobMemoryUsed;
        }

        private static readonly IntPtr s_jobHandle;

        static JobObject()
        {
            try
            {
                s_jobHandle = CreateJobObject(IntPtr.Zero, null);
                var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION_STRUCT();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

                int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION_STRUCT));
                IntPtr alloc = Marshal.AllocHGlobal(length);
                try
                {
                    Marshal.StructureToPtr(info, alloc, false);
                    SetInformationJobObject(s_jobHandle, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, alloc, (uint)length);
                }
                finally
                {
                    Marshal.FreeHGlobal(alloc);
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine("JobObject init failed: " + ex.Message);
            }
        }

        public static void AddProcess(Process process)
        {
            if (s_jobHandle != IntPtr.Zero && process != null && !process.HasExited)
            {
                try
                {
                    AssignProcessToJobObject(s_jobHandle, process.Handle);
                }
                catch (Exception ex)
                {
                    Debug.WriteLine("AssignProcessToJobObject failed: " + ex.Message);
                }
            }
        }
    }
}
