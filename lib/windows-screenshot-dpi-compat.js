const VIRTUAL_SCREEN_MARKER = '[System.Windows.Forms.SystemInformation]::VirtualScreen'
const COPY_FROM_SCREEN_MARKER = '$g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size)'
const SAVE_PATTERN = /\$bmp\.Save\('((?:''|[^'])*)'\)/

function powerShellBasename(file) {
  return String(file ?? '').replace(/\\/g, '/').split('/').pop().toLowerCase()
}

function quotePowerShellSingle(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function savedPathFromLegacyScript(script) {
  const match = SAVE_PATTERN.exec(String(script ?? ''))
  return match ? match[1].replace(/''/g, "'") : undefined
}

export function isLegacyWindowsScreenshotScript(script) {
  const source = String(script ?? '')
  return (
    source.includes('Add-Type -AssemblyName System.Windows.Forms,System.Drawing') &&
    source.includes(VIRTUAL_SCREEN_MARKER) &&
    source.includes('[System.Drawing.Graphics]::FromImage($bmp)') &&
    source.includes(COPY_FROM_SCREEN_MARKER) &&
    savedPathFromLegacyScript(source) !== undefined
  )
}

export function buildPerMonitorWindowsScreenshotScript(outputPath) {
  const quotedPath = quotePowerShellSingle(outputPath)
  const source = String.raw`using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class DshVisionDesktopCapture
{
    private static readonly IntPtr PerMonitorV2 = new IntPtr(-4);
    private static readonly IntPtr PerMonitorV1 = new IntPtr(-3);

    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

    private static IntPtr TrySetContext(IntPtr context)
    {
        try
        {
            return SetThreadDpiAwarenessContext(context);
        }
        catch (EntryPointNotFoundException)
        {
            return IntPtr.Zero;
        }
        catch (DllNotFoundException)
        {
            return IntPtr.Zero;
        }
    }

    private static IntPtr EnterPerMonitorContext()
    {
        IntPtr previous = TrySetContext(PerMonitorV2);
        if (previous == IntPtr.Zero)
        {
            previous = TrySetContext(PerMonitorV1);
        }
        if (previous == IntPtr.Zero)
        {
            throw new InvalidOperationException(
                "could not enter a per-monitor DPI awareness context; refusing to return a potentially misaligned screenshot");
        }
        return previous;
    }

    private static void RestoreContext(IntPtr previous)
    {
        try
        {
            SetThreadDpiAwarenessContext(previous);
        }
        catch
        {
            // The helper process exits immediately after capture. Restoration
            // is still attempted so this method is correct if reused.
        }
    }

    public static void ValidateDpiContext()
    {
        IntPtr previous = EnterPerMonitorContext();
        RestoreContext(previous);
    }

    public static void Capture(string outputPath)
    {
        IntPtr previous = EnterPerMonitorContext();
        try
        {
            Rectangle bounds = SystemInformation.VirtualScreen;
            if (bounds.Width <= 0 || bounds.Height <= 0)
            {
                throw new InvalidOperationException("the Windows virtual screen has no drawable area");
            }

            using (var bitmap = new Bitmap(bounds.Width, bounds.Height))
            using (var graphics = Graphics.FromImage(bitmap))
            {
                graphics.CopyFromScreen(bounds.X, bounds.Y, 0, 0, bounds.Size);
                bitmap.Save(outputPath);
            }
        }
        finally
        {
            RestoreContext(previous);
        }
    }
}`

  return [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
    `$__dshVisionCaptureSource = @'\n${source}\n'@`,
    'try {',
    "  Add-Type -TypeDefinition $__dshVisionCaptureSource -ReferencedAssemblies 'System.Windows.Forms.dll','System.Drawing.dll' -ErrorAction Stop",
    '} catch {',
    "  throw ('vision_screenshot: failed to initialize the Windows DPI-aware capture helper: ' + $_.Exception.Message)",
    '}',
    `[DshVisionDesktopCapture]::Capture(${quotedPath})`,
  ].join('\n')
}

export function rewriteWindowsScreenshotExecArgs(file, args, options = {}) {
  const platform = options.platform ?? (typeof process !== 'undefined' ? process.platform : '')
  if (platform !== 'win32') return args
  const executable = powerShellBasename(file)
  if (executable !== 'powershell.exe' && executable !== 'powershell') return args
  if (!Array.isArray(args)) return args

  const commandIndex = args.findIndex((arg) => String(arg).toLowerCase() === '-command')
  if (commandIndex < 0 || commandIndex + 1 >= args.length) return args
  const script = args[commandIndex + 1]
  if (!isLegacyWindowsScreenshotScript(script)) return args

  const outputPath = savedPathFromLegacyScript(script)
  if (outputPath === undefined) return args
  const rewritten = args.slice()
  rewritten[commandIndex + 1] = buildPerMonitorWindowsScreenshotScript(outputPath)
  return rewritten
}
