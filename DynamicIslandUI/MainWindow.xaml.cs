using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace DynamicIslandUI
{
    /**
     * 動態島 UI (Dynamic Island) 應用程式主視窗
     * 以 WPF 實作，透過 WebSocket 連接 Node.js 伺服器接收播放狀態與歌詞。
     * 支援：平滑展開/收合動畫、隨時拖曳、歌詞高亮、進度插值運算。
     */
    public partial class MainWindow : Window
    {
        private ClientWebSocket _webSocket;
        private static readonly HttpClient client = new HttpClient();

        private List<(TimeSpan Time, string Text)> _parsedLyrics = new();
        private DispatcherTimer _syncTimer;
        private double _currentPositionSec = 0;
        private bool _isPlaying = false;
        private DateTime _lastSyncTime;
        private string _lastDisplayedLyric = null;
        private int _islandLines = 2;
        private double _syncOffset = 0;
        private CancellationTokenSource _pauseCts;

        // 伺服器 port 由 Electron 啟動時以第一個命令列參數傳入 (5720 被占用時會換);獨立執行則預設 5720
        private static readonly int ServerPort = ParseServerPort();
        private static int ParseServerPort()
        {
            var args = Environment.GetCommandLineArgs();
            if (args.Length > 1 && int.TryParse(args[1], out int p) && p > 0 && p < 65536) return p;
            return 5720;
        }

        private class MediaStateUpdate
        {
            public bool IsPlaying;
            public double Position;
            public string Title;
            public string Artist;
            public string Thumbnail;
            public DateTime ReceivedTime;
        }

        private MediaStateUpdate? _latestMediaState;
        private readonly object _stateLock = new object();
        
        private double _currentInterpolatedPosition = 0;
        private double _lastFrameTime = 0;
        private string _lastMediaTitle = "";

        public MainWindow()
        {
            // 安裝後 cwd 是 Program Files,沒寫入權限,crash log 要落在 %APPDATA%
            string logDir = System.IO.Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Kanaric");
            System.IO.Directory.CreateDirectory(logDir);
            AppDomain.CurrentDomain.UnhandledException += (s, e) => {
                System.IO.File.WriteAllText(System.IO.Path.Combine(logDir, "fatal_crash.log"), e.ExceptionObject.ToString());
            };
            Application.Current.DispatcherUnhandledException += (s, e) => {
                System.IO.File.WriteAllText(System.IO.Path.Combine(logDir, "ui_crash.log"), e.Exception.ToString());
                e.Handled = true;
            };
            InitializeComponent();
            this.Loaded += (s, e) => {
                var workArea = SystemParameters.WorkArea;
                this.Left = workArea.Left + (workArea.Width - this.ActualWidth) / 2;
                double invisibleMargin = (this.ActualHeight - IslandBorder.ActualHeight) / 2.0;
                this.Top = workArea.Top - invisibleMargin;
            };

            // 註冊影格渲染事件，用於高頻率的進度條與時間軸插值更新
            System.Windows.Media.CompositionTarget.Rendering += CompositionTarget_Rendering;

            // 啟動 WebSocket 連線
            _ = ConnectWebSocket();
            
            // 監聽 IslandBorder 的大小改變，確保吸附時能維持正確的 Top 座標
            IslandBorder.SizeChanged += IslandBorder_SizeChanged;
        }

        private void IslandBorder_SizeChanged(object sender, SizeChangedEventArgs e)
        {
            if (LeftFlare.Opacity > 0 && !_isDragging)
            {
                double invisibleMargin = (this.ActualHeight - IslandBorder.ActualHeight) / 2.0;
                this.Top = SystemParameters.WorkArea.Top - invisibleMargin;
            }
        }

        private bool _isDragging = false;
        private Point _dragStartMousePos;
        private double _dragStartWindowLeft;
        private double _dragStartWindowTop;

        private void Window_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
        {
            if (e.ButtonState == MouseButtonState.Pressed)
            {
                _isDragging = true;
                _dragStartMousePos = this.PointToScreen(e.GetPosition(this));
                _dragStartWindowLeft = this.Left;
                _dragStartWindowTop = this.Top;
                this.CaptureMouse();
            }
        }

        private void Window_MouseMove(object sender, MouseEventArgs e)
        {
            if (_isDragging)
            {
                Point currentMousePos = this.PointToScreen(e.GetPosition(this));
                double deltaX = currentMousePos.X - _dragStartMousePos.X;
                double deltaY = currentMousePos.Y - _dragStartMousePos.Y;

                PresentationSource source = PresentationSource.FromVisual(this);
                double dpiX = source?.CompositionTarget?.TransformToDevice.M11 ?? 1.0;
                double dpiY = source?.CompositionTarget?.TransformToDevice.M22 ?? 1.0;

                this.Left = _dragStartWindowLeft + (deltaX / dpiX);
                this.Top = _dragStartWindowTop + (deltaY / dpiY);

                // 判斷是否被往下拖曳離開吸附區
                double invisibleMargin = (this.ActualHeight - IslandBorder.ActualHeight) / 2.0;
                double visualTop = this.Top + invisibleMargin;
                if (visualTop > 5 && LeftFlare.Opacity > 0)
                {
                    // 瞬間脫離，恢復圓角
                    LeftFlare.Opacity = 0;
                    RightFlare.Opacity = 0;
                    IslandBorder.CornerRadius = new CornerRadius(40, 40, 40, 40);
                }
            }
        }

        private async void Window_MouseLeftButtonUp(object sender, MouseButtonEventArgs e)
        {
            if (_isDragging)
            {
                _isDragging = false;
                this.ReleaseMouseCapture();

                Point currentMousePos = this.PointToScreen(e.GetPosition(this));
                double deltaX = currentMousePos.X - _dragStartMousePos.X;
                double deltaY = currentMousePos.Y - _dragStartMousePos.Y;

                double invisibleMargin = (this.ActualHeight - IslandBorder.ActualHeight) / 2.0;
                double visualTop = this.Top + invisibleMargin;

                // 若幾乎沒有移動，視為點擊 (Click)
                if (Math.Abs(deltaX) <= 2 && Math.Abs(deltaY) <= 2)
                {
                    var workArea = SystemParameters.WorkArea;
                    if (LeftFlare.Opacity == 0)
                    {
                        // 啟動靈動島 (吸附到最上方)
                        LeftFlare.Opacity = 1;
                        RightFlare.Opacity = 1;
                        this.Top = workArea.Top - invisibleMargin;
                        IslandBorder.CornerRadius = new CornerRadius(0, 0, 40, 40);
                    }
                    else
                    {
                        // 變回圓角 (解除吸附)
                        LeftFlare.Opacity = 0;
                        RightFlare.Opacity = 0;
                        this.Top = workArea.Top + 20; // 回到原本預設高度
                        IslandBorder.CornerRadius = new CornerRadius(40, 40, 40, 40);
                    }
                    return;
                }

                // 若有拖曳且拖曳結束時靠近頂部，則吸附
                if (visualTop < 5)
                {
                    double startTop = this.Top;
                    // 完全貼齊螢幕頂端
                    double targetTop = SystemParameters.WorkArea.Top - invisibleMargin;

                    // 不加加上方 Padding，保持本體靠近螢幕邊緣

                    if (Math.Abs(this.Top - targetTop) > 0.5)
                    {
                        double startCorner = IslandBorder.CornerRadius.TopLeft;
                        double startOpacity = LeftFlare.Opacity;
                        int steps = 20;
                        int delay = 15;
                        
                        for (int i = 1; i <= steps; i++)
                        {
                            double t = (double)i / steps;
                            double ease = 1 - Math.Pow(1 - t, 4);
                            this.Top = startTop + (targetTop - startTop) * ease;
                            
                            double currentCorner = startCorner * (1 - ease);
                            double currentOp = startOpacity + (1 - startOpacity) * ease;
                            
                            IslandBorder.CornerRadius = new CornerRadius(currentCorner, currentCorner, 40, 40);
                            LeftFlare.Opacity = currentOp;
                            RightFlare.Opacity = currentOp;
                            
                            await Task.Delay(delay);
                        }
                        this.Top = targetTop;
                        IslandBorder.CornerRadius = new CornerRadius(0, 0, 40, 40);
                        LeftFlare.Opacity = 1;
                        RightFlare.Opacity = 1;
                    }
                }
            }
        }

        private async Task ConnectWebSocket()
        {
            while (true)
            {
                try
                {
                    _webSocket = new ClientWebSocket();
                    Application.Current.Dispatcher.Invoke(() => SetFuriganaText(LyricLine1, "連線伺服器中...", 14, Brushes.White));
                    
                    await _webSocket.ConnectAsync(new Uri($"ws://localhost:{ServerPort}"), CancellationToken.None);
                    Application.Current.Dispatcher.Invoke(() => SetFuriganaText(LyricLine1, "已連線", 14, Brushes.White));

                    var buffer = new byte[1024 * 32];
                    while (_webSocket.State == WebSocketState.Open)
                    {
                        using var ms = new MemoryStream();
                        WebSocketReceiveResult result;
                        do
                        {
                            result = await _webSocket.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
                            if (result.MessageType == WebSocketMessageType.Close) break;
                            ms.Write(buffer, 0, result.Count);
                        }
                        while (!result.EndOfMessage);

                        if (result.MessageType == WebSocketMessageType.Close) break;

                        string message = Encoding.UTF8.GetString(ms.ToArray());
                        ProcessMessage(message);
                    }
                }
                catch (Exception)
                {
                    Application.Current.Dispatcher.Invoke(() => {
                        SongText.Visibility = Visibility.Visible;
                        SongText.Text = "伺服器斷線";
                        SetFuriganaText(LyricLine1, "正在嘗試重新連線...", 14, Brushes.White);
                        LyricLine2.Children.Clear();
                        AnimateIslandState(false);
                    });
                }
                await Task.Delay(3000);
            }
        }

        private void ProcessMessage(string message)
        {
            try
            {
                using JsonDocument doc = JsonDocument.Parse(message);
                var root = doc.RootElement;
                string type = root.GetProperty("type").GetString();

                if (type == "media_state" || type == "init")
                {
                    var state = root.GetProperty("state");
                    bool isPlaying = state.GetProperty("is_playing").GetBoolean();
                    string title = state.GetProperty("title").GetString();
                    string artist = state.GetProperty("artist").GetString();
                    double position = state.TryGetProperty("position", out var pos) ? pos.GetDouble() : 0;
                    string thumbnail = state.TryGetProperty("thumbnail", out var thumb) ? thumb.GetString() : "";

                    if (type == "init" && root.TryGetProperty("settings", out var settings))
                    {
                        Application.Current.Dispatcher.Invoke(() =>
                        {
                            if (settings.TryGetProperty("island_lines", out var linesElement))
                            {
                                _islandLines = linesElement.GetInt32();
                                LyricLine2.Visibility = (_islandLines == 1) ? Visibility.Collapsed : Visibility.Visible;
                            }
                        });
                    }

                    var stateUpdate = new MediaStateUpdate
                    {
                        IsPlaying = isPlaying,
                        Position = position,
                        Title = title,
                        Artist = artist,
                        Thumbnail = thumbnail,
                        ReceivedTime = DateTime.Now
                    };

                    lock (_stateLock)
                    {
                        _latestMediaState = stateUpdate;
                    }
                }
                else if (type == "lyrics_updated")
                {
                    string lyrics = root.GetProperty("lyrics").GetString();
                    Application.Current.Dispatcher.Invoke(() =>
                    {
                        ParseLRC(lyrics);
                        AnimateIslandState(true);
                    });
                }
                else if (type == "settings_updated")
                {
                    var settings = root.GetProperty("settings");
                    Application.Current.Dispatcher.Invoke(() =>
                    {
                        if (settings.TryGetProperty("island_lines", out var linesElement))
                        {
                            _islandLines = linesElement.GetInt32();
                            if (_islandLines == 1)
                            {
                                LyricLine2.Visibility = Visibility.Collapsed;
                            }
                            else
                            {
                                LyricLine2.Visibility = Visibility.Visible;
                            }
                        }
                        
                        // Force a refetch of lyrics on next media state update
                        SongText.Text = "";
                    });
                }
                else if (type == "sync_offset_updated")
                {
                    double offset = root.TryGetProperty("offset", out var offsetElem) ? offsetElem.GetDouble() : 0.0;
                    Application.Current.Dispatcher.Invoke(() =>
                    {
                        _syncOffset = offset;
                    });
                }
            }
            catch (Exception ex) { Console.WriteLine("JSON Error: " + ex.Message); }
        }

        private async Task FetchSyncOffset(string title, string artist)
        {
            try
            {
                using HttpClient client = new HttpClient();
                string url = $"http://localhost:{ServerPort}/api/lyrics/offset?title={Uri.EscapeDataString(title)}&artist={Uri.EscapeDataString(artist)}";
                string response = await client.GetStringAsync(url);
                using JsonDocument doc = JsonDocument.Parse(response);
                if (doc.RootElement.TryGetProperty("offset", out var offsetElem))
                {
                    Application.Current.Dispatcher.Invoke(() => {
                        _syncOffset = offsetElem.GetDouble();
                    });
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("Error fetching sync offset: " + ex.Message);
            }
        }

        private async Task FetchRawLyrics(string title, string artist)
        {
            try
            {
                string url = $"http://localhost:{ServerPort}/api/lyrics/raw?title={Uri.EscapeDataString(title)}&artist={Uri.EscapeDataString(artist)}";
                string response = await client.GetStringAsync(url);
                using JsonDocument doc = JsonDocument.Parse(response);
                if (doc.RootElement.TryGetProperty("lyrics", out JsonElement lyricsElement))
                {
                    string lyrics = lyricsElement.GetString();
                    if (!string.IsNullOrEmpty(lyrics))
                    {
                        Application.Current.Dispatcher.Invoke(() => ParseLRC(lyrics));
                    }
                }
            }
            catch { }
        }

        private void UpdateAlbumArt(string base64String)
        {
            if (string.IsNullOrEmpty(base64String))
            {
                AlbumArt.Source = null;
                return;
            }
            try
            {
                byte[] imageBytes = Convert.FromBase64String(base64String);
                using var ms = new MemoryStream(imageBytes);
                var bitmap = new BitmapImage();
                bitmap.BeginInit();
                bitmap.CacheOption = BitmapCacheOption.OnLoad;
                bitmap.StreamSource = ms;
                bitmap.EndInit();
                AlbumArt.Source = bitmap;
            }
            catch { }
        }

        private void ParseLRC(string lrcData)
        {
            _parsedLyrics.Clear();
            _lastDisplayedLyric = null;
            if (string.IsNullOrEmpty(lrcData))
            {
                SongText.Visibility = Visibility.Visible;
                LyricLine1.Children.Clear();
                LyricLine2.Children.Clear();
                return;
            }

            var lines = lrcData.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            Regex regex = new Regex(@"\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)");
            
            foreach (var line in lines)
            {
                var match = regex.Match(line);
                if (match.Success)
                {
                    int m = int.Parse(match.Groups[1].Value);
                    int s = int.Parse(match.Groups[2].Value);
                    int ms = int.Parse(match.Groups[3].Value.PadRight(3, '0'));
                    string text = match.Groups[4].Value.Trim();
                    
                    if (text.Contains("#TITLE#"))
                        continue;
                    
                    var time = new TimeSpan(0, 0, m, s, ms);
                    _parsedLyrics.Add((time, text));
                }
            }
            
            if (_parsedLyrics.Count == 0 && lines.Length > 0)
            {
                SongText.Visibility = Visibility.Visible;
                SetFuriganaText(LyricLine1, lines[0], 14, Brushes.White);
                if (lines.Length > 1)
                    SetFuriganaText(LyricLine2, lines[1], 12, new SolidColorBrush(Color.FromArgb(180, 255, 255, 255)));
                else
                    LyricLine2.Children.Clear();
            }
        }

        private void CompositionTarget_Rendering(object? sender, EventArgs e)
        {
            var now = TimeSpan.FromTicks(DateTime.Now.Ticks).TotalSeconds;
            if (_lastFrameTime == 0) _lastFrameTime = now;
            double dt = now - _lastFrameTime;
            _lastFrameTime = now;

            MediaStateUpdate? updateToProcess = null;
            lock (_stateLock)
            {
                if (_latestMediaState != null)
                {
                    updateToProcess = _latestMediaState;
                    _latestMediaState = null;
                }
            }

            if (updateToProcess != null)
            {
                _isPlaying = updateToProcess.IsPlaying;
                
                if (_isPlaying)
                {
                    double diff = updateToProcess.Position - _currentInterpolatedPosition;
                    if (Math.Abs(diff) > 1.0 || _lastMediaTitle != updateToProcess.Title)
                    {
                        _currentInterpolatedPosition = updateToProcess.Position;
                    }
                    // Removed else block that was doing _currentInterpolatedPosition += diff * 0.5;
                    // This prevents the playhead from jumping backwards due to IPC latency jitter, which causes flickering.
                }
                else
                {
                    _currentInterpolatedPosition = updateToProcess.Position;
                }

                if (!string.IsNullOrEmpty(updateToProcess.Title))
                {
                    if (SongText.Text != $"{updateToProcess.Title} - {updateToProcess.Artist}")
                    {
                        _lastMediaTitle = updateToProcess.Title;
                        SongText.Text = $"{updateToProcess.Title} - {updateToProcess.Artist}";
                        _parsedLyrics.Clear();
                        _lastDisplayedLyric = null;
                        SongText.Visibility = Visibility.Visible;
                        LyricLine1.Children.Clear();
                        LyricLine2.Children.Clear();
                        _ = FetchRawLyrics(updateToProcess.Title, updateToProcess.Artist);
                        _ = FetchSyncOffset(updateToProcess.Title, updateToProcess.Artist);
                        UpdateAlbumArt(updateToProcess.Thumbnail);
                    }
                }

                if (_isPlaying && !string.IsNullOrEmpty(updateToProcess.Title))
                {
                    AnimateIslandState(true);
                }
                else if (!_isPlaying)
                {
                    AnimateIslandState(false);
                }
            }

            if (_isPlaying)
            {
                _currentInterpolatedPosition += dt;
            }

            if (_parsedLyrics.Count > 0)
            {
                // 我們在此偷偷加上 0.5 秒的視覺補償，抵銷淡入動畫與大腦反應時間以及伺服器傳輸延遲，讓靈動島的出現時機感覺更「跟手」
                TimeSpan currentTs = TimeSpan.FromSeconds(_currentInterpolatedPosition - _syncOffset + 0.5);
                
                // 判斷是否為前奏 (目前時間小於第一句歌詞)
                bool isIntro = currentTs < _parsedLyrics[0].Time;

                if (isIntro)
                {
                    SongText.Visibility = Visibility.Visible;
                    if (_lastDisplayedLyric != "INTRO")
                    {
                        _lastDisplayedLyric = "INTRO";
                        LyricLine1.Children.Clear();
                        LyricLine2.Children.Clear();
                    }
                    return;
                }

                // Determine active index
                int activeIndex = -1;
                for (int i = 0; i < _parsedLyrics.Count; i++)
                {
                    if (_parsedLyrics[i].Time <= currentTs)
                        activeIndex = i;
                    else
                        break;
                }

                if (activeIndex >= 0)
                {
                    string activeLyric = _parsedLyrics[activeIndex].Text;
                    string line1Text = activeLyric;
                    if (string.IsNullOrEmpty(activeLyric))
                    {
                        if (activeIndex + 1 < _parsedLyrics.Count)
                        {
                            line1Text = _parsedLyrics[activeIndex + 1].Text;
                        }
                        else
                        {
                            for (int i = activeIndex - 1; i >= 0; i--)
                            {
                                if (!string.IsNullOrEmpty(_parsedLyrics[i].Text))
                                {
                                    line1Text = _parsedLyrics[i].Text;
                                    break;
                                }
                            }
                        }
                    }
                    string newDisplayedLyric = line1Text;

                    if (_lastDisplayedLyric != newDisplayedLyric)
                    {
                        _lastDisplayedLyric = newDisplayedLyric;

                        SongText.Visibility = Visibility.Collapsed;
                        
                        string line2Text = "";
                        if (string.IsNullOrEmpty(activeLyric) && activeIndex + 1 < _parsedLyrics.Count)
                        {
                            if (activeIndex + 2 < _parsedLyrics.Count && !string.IsNullOrEmpty(_parsedLyrics[activeIndex + 2].Text))
                                line2Text = _parsedLyrics[activeIndex + 2].Text;
                        }
                        else
                        {
                            if (activeIndex + 1 < _parsedLyrics.Count && !string.IsNullOrEmpty(_parsedLyrics[activeIndex + 1].Text))
                                line2Text = _parsedLyrics[activeIndex + 1].Text;
                            else if (activeIndex + 2 < _parsedLyrics.Count && string.IsNullOrEmpty(_parsedLyrics[activeIndex + 1].Text) && !string.IsNullOrEmpty(_parsedLyrics[activeIndex + 2].Text))
                                line2Text = _parsedLyrics[activeIndex + 2].Text;
                        }

                        SetFuriganaText(LyricLine1, line1Text, 20, Brushes.White);
                        
                        if (!string.IsNullOrEmpty(line2Text))
                        {
                            SetFuriganaText(LyricLine2, line2Text, 16, new SolidColorBrush(Color.FromArgb(150, 255, 255, 255)));
                        }
                        else
                        {
                            LyricLine2.Children.Clear();
                        }

                        // 瞬間切換文字後，加入明亮化與微浮動動畫
                        var fadeInAnim = new DoubleAnimation(0.2, 1.0, TimeSpan.FromSeconds(0.2));
                        LyricsContainer.BeginAnimation(UIElement.OpacityProperty, fadeInAnim);

                        var marginAnim1 = new ThicknessAnimation(new Thickness(0, 4, 0, 0), new Thickness(0, 0, 0, 0), TimeSpan.FromSeconds(0.2)) { EasingFunction = new QuarticEase() { EasingMode = EasingMode.EaseOut } };
                        LyricLine1.BeginAnimation(FrameworkElement.MarginProperty, marginAnim1);
                        if (LyricLine2.Children.Count > 0)
                        {
                            var marginAnim2 = new ThicknessAnimation(new Thickness(0, 8, 0, 0), new Thickness(0, 4, 0, 0), TimeSpan.FromSeconds(0.3)) { EasingFunction = new QuarticEase() { EasingMode = EasingMode.EaseOut } };
                            LyricLine2.BeginAnimation(FrameworkElement.MarginProperty, marginAnim2);
                        }
                    }
                }
            }
        }

        private void SetFuriganaText(WrapPanel panel, string htmlLyric, double fontSize, Brush color)
        {
            panel.Children.Clear();
            if (string.IsNullOrEmpty(htmlLyric)) return;

            // 解析 <ruby> 標籤
            var regex = new Regex(@"<ruby[^>]*>(.*?)<rt>(.*?)</rt></ruby>");
            int lastIndex = 0;

            foreach (Match match in regex.Matches(htmlLyric))
            {
                if (match.Index > lastIndex)
                {
                    string plainText = htmlLyric.Substring(lastIndex, match.Index - lastIndex);
                    plainText = Regex.Replace(plainText, "<.*?>", ""); // 清除殘留標籤
                    if (!string.IsNullOrEmpty(plainText))
                    {
                        panel.Children.Add(new TextBlock { Text = plainText, FontSize = fontSize, Foreground = color, VerticalAlignment = VerticalAlignment.Bottom });
                    }
                }

                string kanji = match.Groups[1].Value;
                string kana = match.Groups[2].Value;

                var rubyStack = new StackPanel { Orientation = Orientation.Vertical, Margin = new Thickness(1, 0, 1, 0), VerticalAlignment = VerticalAlignment.Bottom };
                rubyStack.Children.Add(new TextBlock { Text = kana, FontSize = fontSize * 0.6, Foreground = color, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 0, 0, -2) });
                rubyStack.Children.Add(new TextBlock { Text = kanji, FontSize = fontSize, Foreground = color, HorizontalAlignment = HorizontalAlignment.Center });

                panel.Children.Add(rubyStack);

                lastIndex = match.Index + match.Length;
            }

            if (lastIndex < htmlLyric.Length)
            {
                string plainText = htmlLyric.Substring(lastIndex);
                plainText = Regex.Replace(plainText, "<.*?>", "");
                if (!string.IsNullOrEmpty(plainText))
                {
                    panel.Children.Add(new TextBlock { Text = plainText, FontSize = fontSize, Foreground = color, VerticalAlignment = VerticalAlignment.Bottom });
                }
            }
        }

        private bool _wasPlaying = false;

        private async void AnimateIslandState(bool isPlaying)
        {
            if (isPlaying)
            {
                _pauseCts?.Cancel();
                if (!_wasPlaying)
                {
                    _wasPlaying = true;
                    this.Topmost = false;
                    this.Topmost = true;
                    
                    DoubleAnimation opacityAnim = new DoubleAnimation
                    {
                        To = 1.0,
                        Duration = TimeSpan.FromSeconds(0.4)
                    };
                    MainContainer.BeginAnimation(UIElement.OpacityProperty, opacityAnim);
                }
            }
            else
            {
                if (_wasPlaying)
                {
                    _wasPlaying = false;
                    _pauseCts?.Cancel();
                    _pauseCts = new CancellationTokenSource();
                    var token = _pauseCts.Token;

                    try
                    {
                        // 暫停時維持原樣，等待 3 秒
                        await Task.Delay(3000, token);

                        if (token.IsCancellationRequested) return;

                        // 3 秒後，淡出整個視窗讓它消失在螢幕上
                        DoubleAnimation windowFadeAnim = new DoubleAnimation
                        {
                            To = 0.0,
                            Duration = TimeSpan.FromSeconds(1.0)
                        };
                        MainContainer.BeginAnimation(UIElement.OpacityProperty, windowFadeAnim);
                    }
                    catch (TaskCanceledException) { }
                }
            }
        }
    }
}