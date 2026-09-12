import fs from "node:fs";
import path from "node:path";

type RelaunchApplication = {
  isPackaged: boolean;
  relaunch(options?: { execPath: string; args: string[] }): void;
  quit(): void;
};

/**
 * Prepare before changing a profile, then restart through its portable wrapper.
 * Current packaged Windows profile-management callers are portable builds;
 * missing wrapper metadata must fail instead of relaunching the extracted EXE.
 */
export function prepareApplicationRelaunch(app: RelaunchApplication): () => void {
  if (!app.isPackaged || process.platform !== "win32") {
    return () => { app.relaunch(); app.quit(); };
  }
  const executable = process.env.PORTABLE_EXECUTABLE_FILE;
  const directory = process.env.PORTABLE_EXECUTABLE_DIR;
  let execPath: string, workingDirectory: string;
  try {
    if (!executable || !directory || !path.isAbsolute(executable) || !path.isAbsolute(directory)
      || path.extname(executable).toLowerCase() !== ".exe") throw new Error();
    execPath = path.resolve(executable);
    workingDirectory = path.resolve(directory);
    if (path.dirname(execPath).toLowerCase() !== workingDirectory.toLowerCase()
      || !fs.statSync(execPath).isFile() || !fs.statSync(workingDirectory).isDirectory()
      || fs.realpathSync(execPath).toLowerCase() === fs.realpathSync(process.execPath).toLowerCase()) throw new Error();
  } catch { throw new Error("PROFILE_RELAUNCH_UNAVAILABLE"); }
  const args = process.argv.slice(1);
  return () => {
    const previousDirectory = process.cwd();
    try {
      process.chdir(workingDirectory);
      app.relaunch({ execPath, args });
    } catch (error) {
      process.chdir(previousDirectory);
      throw error;
    }
    app.quit();
  };
}
