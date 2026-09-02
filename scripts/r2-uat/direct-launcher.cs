using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class DirectLauncher
{
    private const string ErrorMessage =
        "UAT 실행을 시작할 수 없습니다. 패키지를 다시 확인하거나 담당자에게 문의해 주세요.";

    [STAThread]
    private static int Main()
    {
        try
        {
            string packageRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar);
            string nodePath = Path.Combine(packageRoot, "runtime", "node.exe");
            string runnerPath = Path.Combine(packageRoot, "runtime", "uat-runner.js");
            string appKey = ResolveApp(Path.GetFileName(Application.ExecutablePath));

            if (!File.Exists(nodePath) || !File.Exists(runnerPath))
            {
                throw new InvalidOperationException();
            }

            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = nodePath,
                Arguments = Quote(runnerPath) + " --app=" + appKey,
                WorkingDirectory = packageRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };

            using (Process process = Process.Start(startInfo))
            {
                if (process == null)
                {
                    throw new InvalidOperationException();
                }

                process.WaitForExit();
                if (process.ExitCode != 0)
                {
                    ShowError();
                    return 1;
                }
            }

            return 0;
        }
        catch
        {
            ShowError();
            return 2;
        }
    }

    private static string ResolveApp(string executableName)
    {
        switch (executableName.ToLowerInvariant())
        {
            case "g-science ai 타자왕.exe":
                return "ai";
            case "g-science ai 타자왕 리더보드.exe":
                return "ai-leaderboard";
            case "g-science ai 타자왕 연습모드.exe":
                return "practice";
            case "g-science ai 타자왕 연습모드 리더보드.exe":
                return "practice-leaderboard";
            default:
                throw new InvalidOperationException();
        }
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static void ShowError()
    {
        MessageBox.Show(
            ErrorMessage,
            "G-Science AI 타자왕 UAT",
            MessageBoxButtons.OK,
            MessageBoxIcon.Error);
    }
}
