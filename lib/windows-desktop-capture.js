import { execFile as importedExecFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

function quotePowerShellSingle(value) {
  return `'${String(value).replace(/'/g, "''")}'`
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

// Snapshot the native function at module evaluation. Screenshot correctness
// must not depend on the process-wide promisify(execFile) compatibility seam
// used by legacy Tesseract stdin support.
const nativeExecFile = importedExecFile

function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    nativeExecFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        if (error && typeof error === 'object') {
          try {
            error.stdout = stdout
            error.stderr = stderr
          } catch {
            /* preserve the original child-process error */
          }
        }
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

export function isAsciiWindowsPath(value) {
  return typeof value === 'string' && value !== '' && /^[\x20-\x7e]+$/.test(value)
}

function captureTempRoots(env, tmpRoot) {
  const roots = []
  const add = (value) => {
    if (!isAsciiWindowsPath(value) || roots.includes(value)) return
    roots.push(value)
  }
  add(tmpRoot)
  add(env?.TEMP)
  add(env?.TMP)
  if (isAsciiWindowsPath(env?.SystemRoot)) add(path.win32.join(env.SystemRoot, 'Temp'))
  if (isAsciiWindowsPath(env?.WINDIR)) add(path.win32.join(env.WINDIR, 'Temp'))
  return roots
}

/**
 * CodeDom-backed PowerShell Add-Type uses TEMP/TMP while compiling the small
 * DPI-aware C# helper. On Windows profiles whose temp path contains non-ASCII
 * characters that compilation can fail before capture starts (#409). Pick a
 * writable ASCII scratch directory without ever mutating process.env.
 */
export async function createWindowsCaptureTempDir(options = {}) {
  const env = options.env ?? (typeof process !== 'undefined' ? process.env : {})
  const tmpRoot = options.tmpRoot ?? tmpdir()
  const makeTempDir = options.mkdtemp ?? mkdtemp
  const roots = captureTempRoots(env, tmpRoot)
  const failures = []

  for (const root of roots) {
    try {
      return await makeTempDir(path.win32.join(root, 'dsh-vision-router-capture-'))
    } catch (error) {
      failures.push(error && error.message ? error.message : String(error))
    }
  }

  const error = new Error(
    'vision_screenshot: no writable ASCII temporary directory is available for the Windows DPI-aware capture helper',
  )
  error.code = 'WINDOWS_CAPTURE_TEMP_UNAVAILABLE'
  if (failures.length > 0) error.cause = new Error(failures.join(' | '))
  throw error
}

/**
 * Capture the Windows virtual desktop with per-monitor DPI awareness.
 *
 * This is the production owner of the Windows screenshot operation. It calls
 * the PMv2 -> PMv1 helper directly and fails closed if a correct DPI context
 * cannot be entered; it never falls back to the known-broken logical-coordinate
 * legacy script. macOS/Linux capture remains owned by index.js.
 */
export async function captureWindowsDesktop(outputPath, options = {}) {
  const env = options.env ?? (typeof process !== 'undefined' ? process.env : {})
  const removeTempDir = options.rm ?? rm
  const run = options.execFileAsync ?? execFileAsync
  let scratchDir

  try {
    scratchDir = await createWindowsCaptureTempDir({
      env,
      tmpRoot: options.tmpRoot,
      mkdtemp: options.mkdtemp,
    })
    const script = buildPerMonitorWindowsScreenshotScript(outputPath)
    const execOptions = {
      windowsHide: true,
      cwd: scratchDir,
      env: {
        ...env,
        TEMP: scratchDir,
        TMP: scratchDir,
      },
      ...(Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? { timeout: options.timeoutMs }
        : {}),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }
    await run(
      options.powershell ?? 'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      execOptions,
    )
  } catch (error) {
    if (error?.code === 'WINDOWS_CAPTURE_TEMP_UNAVAILABLE') throw error
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error
    const wrapped = new Error(
      `vision_screenshot: Windows DPI-aware capture failed (${error && error.message ? error.message : String(error)})`,
    )
    wrapped.code = 'WINDOWS_DPI_CAPTURE_FAILED'
    wrapped.cause = error
    throw wrapped
  } finally {
    if (scratchDir) {
      try {
        await removeTempDir(scratchDir, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        })
      } catch {
        // Antivirus/indexing can briefly retain CodeDom files. Cleanup is
        // best-effort and must not turn a valid screenshot into a failure.
      }
    }
  }
}
