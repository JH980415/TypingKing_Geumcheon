using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class TypingKingDpapiBridge
{
    private const int PlainLimit = 8 * 1024 * 1024;
    private const int CipherLimit = PlainLimit + 64 * 1024;
    private const int UiForbidden = 1;
    private static readonly byte[] Magic = { 84, 75, 68, 80, 65, 80, 73, 1 };
    private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);

    [StructLayout(LayoutKind.Sequential)]
    private struct DataBlob { public int Size; public IntPtr Data; }

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptProtectData(ref DataBlob input, string description, IntPtr entropy,
        IntPtr reserved, IntPtr prompt, int flags, out DataBlob output);

    [DllImport("crypt32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptUnprotectData(ref DataBlob input, out IntPtr description, IntPtr entropy,
        IntPtr reserved, IntPtr prompt, int flags, out DataBlob output);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    private static void Clear(byte[] value) { if (value != null) Array.Clear(value, 0, value.Length); }
    private static void ClearNative(IntPtr pointer, int length)
    {
        if (pointer == IntPtr.Zero || length <= 0) return;
        byte[] zero = new byte[Math.Min(length, 65536)];
        for (int offset = 0; offset < length; offset += zero.Length)
            Marshal.Copy(zero, 0, IntPtr.Add(pointer, offset), Math.Min(zero.Length, length - offset));
    }
    private static byte[] Transform(byte[] input, bool protect)
    {
        DataBlob source = new DataBlob { Size = input.Length, Data = Marshal.AllocHGlobal(Math.Max(1, input.Length)) };
        DataBlob result = new DataBlob();
        IntPtr description = IntPtr.Zero;
        try
        {
            Marshal.Copy(input, 0, source.Data, input.Length);
            // No LOCAL_MACHINE flag: only the current Windows user's DPAPI identity can decrypt.
            bool ok = protect
                ? CryptProtectData(ref source, "TypingKing protected data v1", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, UiForbidden, out result)
                : CryptUnprotectData(ref source, out description, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, UiForbidden, out result);
            if (!ok || result.Size < 0 || result.Size > (protect ? CipherLimit - Magic.Length : PlainLimit))
                throw new InvalidOperationException();
            byte[] value = new byte[result.Size];
            if (result.Size > 0) Marshal.Copy(result.Data, value, 0, result.Size);
            return value;
        }
        finally
        {
            ClearNative(source.Data, source.Size);
            Marshal.FreeHGlobal(source.Data);
            if (result.Data != IntPtr.Zero) { ClearNative(result.Data, Math.Max(0, result.Size)); LocalFree(result.Data); }
            if (description != IntPtr.Zero) LocalFree(description);
        }
    }
    private static byte[] ReadInput()
    {
        using (Stream input = Console.OpenStandardInput())
        using (MemoryStream memory = new MemoryStream())
        {
            byte[] buffer = new byte[65536];
            try
            {
                int count;
                while ((count = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    if (memory.Length + count > CipherLimit) throw new InvalidOperationException();
                    memory.Write(buffer, 0, count);
                }
                return memory.ToArray();
            }
            finally
            {
                Clear(buffer);
                Clear(memory.GetBuffer());
            }
        }
    }
    private static byte[] Protect(byte[] input)
    {
        if (input.Length > PlainLimit) throw new InvalidOperationException();
        StrictUtf8.GetCharCount(input);
        byte[] body = Transform(input, true);
        try
        {
            byte[] output = new byte[Magic.Length + body.Length];
            Buffer.BlockCopy(Magic, 0, output, 0, Magic.Length);
            Buffer.BlockCopy(body, 0, output, Magic.Length, body.Length);
            return output;
        }
        finally { Clear(body); }
    }
    private static byte[] Unprotect(byte[] input)
    {
        if (input.Length <= Magic.Length || input.Length > CipherLimit) throw new InvalidOperationException();
        for (int i = 0; i < Magic.Length; i++) if (input[i] != Magic[i]) throw new InvalidOperationException();
        byte[] body = new byte[input.Length - Magic.Length];
        Buffer.BlockCopy(input, Magic.Length, body, 0, body.Length);
        byte[] output = null;
        try
        {
            output = Transform(body, false);
            StrictUtf8.GetCharCount(output);
            return output;
        }
        catch { Clear(output); throw; }
        finally { Clear(body); }
    }
    private static int Main(string[] args)
    {
        byte[] input = null, output = null, protectedProbe = null, recoveredProbe = null;
        try
        {
            if (args.Length != 1) throw new InvalidOperationException();
            input = ReadInput();
            if (args[0] == "protect") output = Protect(input);
            else if (args[0] == "unprotect") output = Unprotect(input);
            else if (args[0] == "probe")
            {
                if (input.Length != 0) throw new InvalidOperationException();
                byte[] probe = Encoding.ASCII.GetBytes("TypingKing CurrentUser DPAPI probe v1");
                try
                {
                    protectedProbe = Protect(probe);
                    recoveredProbe = Unprotect(protectedProbe);
                    if (probe.Length != recoveredProbe.Length) throw new InvalidOperationException();
                    for (int i = 0; i < probe.Length; i++) if (probe[i] != recoveredProbe[i]) throw new InvalidOperationException();
                }
                finally { Clear(probe); }
                output = Encoding.ASCII.GetBytes("TKDPAPI_OK_V1");
            }
            else throw new InvalidOperationException();
            using (Stream stdout = Console.OpenStandardOutput()) { stdout.Write(output, 0, output.Length); stdout.Flush(); }
            return 0;
        }
        catch
        {
            // Never print exception text, input, DPAPI output, paths, or Windows error details.
            Console.Error.Write("DPAPI_BRIDGE_FAILED");
            return 1;
        }
        finally { Clear(input); Clear(output); Clear(protectedProbe); Clear(recoveredProbe); }
    }
}
