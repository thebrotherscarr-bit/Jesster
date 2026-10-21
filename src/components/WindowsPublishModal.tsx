import React, { useState } from 'react';
import { usePWAInstall } from '../hooks/usePWAInstall.ts';
import {
  X,
  Copy,
  Check,
  Monitor,
  Sparkles,
  Layers,
  Terminal,
  FolderOpen,
} from 'lucide-react';

interface WindowsPublishModalProps {
  isOpen: boolean;
  onClose: () => void;
  appUrl: string;
}

const EXE_RELATIVE_PATH = 'dist-desktop\\SecondBrain-win32-x64\\SecondBrain.exe';
const REBUILD_COMMAND = 'npm run package:win';

export const WindowsPublishModal: React.FC<WindowsPublishModalProps> = ({
  isOpen,
  onClose,
  appUrl,
}) => {
  const { isInstallable, isInstalled, install } = usePWAInstall();
  const [copied, setCopied] = useState<string | null>(null);

  if (!isOpen) return null;

  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : appUrl;
  const repoRoot =
    typeof window !== 'undefined' && window.location.protocol.startsWith('http')
      ? 'this project folder'
      : 'the folder containing SecondBrain.exe';

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="windows-publish-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150"
    >
      <div className="relative w-full max-w-2xl bg-neutral-900 border border-neutral-800 rounded-2xl shadow-2xl p-6 overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-neutral-800 shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-neutral-800 border border-neutral-700 text-neutral-200">
              <Monitor className="w-5 h-5 text-emerald-400" />
            </div>
            <div>
              <h2 id="windows-publish-title" className="text-lg font-bold text-white tracking-tight">
                Desktop App & Windows Install
              </h2>
              <p className="text-xs text-neutral-400">
                Run the packaged Electron build, or install the same app as a PWA
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close desktop app modal"
            className="p-1.5 text-neutral-400 hover:text-white rounded-lg hover:bg-neutral-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto py-5 space-y-5 pr-1">
          {/* Method 1: the real packaged Electron app */}
          <div className="p-4 rounded-xl bg-gradient-to-br from-neutral-900 to-neutral-950 border border-neutral-800 space-y-3">
            <div>
              <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-400">
                Recommended · already built
              </span>
              <h3 className="text-sm font-bold text-white mt-0.5">
                Launch the native Electron app
              </h3>
              <p className="text-xs text-neutral-400 mt-1 leading-relaxed">
                The full offline desktop build is included in this folder. It serves itself from a
                stable loopback origin, so notes saved in the app persist between launches.
              </p>
            </div>

            <div className="p-2.5 bg-neutral-950 border border-neutral-800 rounded-lg font-mono text-[11px] text-emerald-400 select-all overflow-x-auto">
              {EXE_RELATIVE_PATH}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => copyToClipboard(EXE_RELATIVE_PATH, 'exe')}
                className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-neutral-900 bg-white hover:bg-neutral-100 rounded-lg transition-colors"
              >
                {copied === 'exe' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied === 'exe' ? 'Path copied' : 'Copy app path'}</span>
              </button>

              <button
                onClick={() => copyToClipboard(currentOrigin, 'origin')}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-neutral-300 hover:text-white bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-lg transition-colors"
              >
                {copied === 'origin' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied === 'origin' ? 'Current URL copied' : 'Copy current URL'}</span>
              </button>
            </div>

            <p className="text-[11px] text-neutral-500 leading-relaxed">
              Notes live in <code className="text-neutral-400">%APPDATA%\SecondBrain</code>. Use the
              sidebar&apos;s Export button for a portable JSON backup.
            </p>
          </div>

          {/* Method 2: PWA */}
          <div className="p-4 rounded-xl bg-neutral-950 border border-neutral-800 space-y-3">
            <div>
              <span className="text-[11px] font-bold uppercase tracking-wider text-cyan-400">
                Native Windows OS integration
              </span>
              <h3 className="text-sm font-bold text-white mt-0.5">
                Install as an Edge / Chrome app
              </h3>
              <p className="text-xs text-neutral-400 mt-1 leading-relaxed">
                When the app is served from a browser origin, Windows can register it with Start
                Menu search, taskbar pinning, and its own app window.
              </p>
            </div>

            <div className="pt-1">
              {isInstalled ? (
                <div className="inline-flex items-center gap-2 px-3 py-1.5 text-xs text-emerald-400 bg-emerald-950/40 border border-emerald-800/60 rounded-lg">
                  <Check className="w-4 h-4" />
                  <span>Already installed as a desktop app</span>
                </div>
              ) : isInstallable ? (
                <button
                  onClick={install}
                  className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-colors"
                >
                  <Monitor className="w-4 h-4" />
                  <span>Install Desktop App to Windows</span>
                </button>
              ) : (
                <div className="text-xs text-neutral-400 flex items-start gap-1.5 leading-relaxed">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                  <span>
                    Open the app in Edge or Chrome, then use the <strong>App icon</strong> in the
                    address bar (or Menu &gt; Apps &gt; Install SecondBrain).
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Method 3: rebuild */}
          <div className="p-4 rounded-xl bg-neutral-950 border border-neutral-800 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-neutral-400" />
                <span className="text-xs font-bold text-neutral-200">Rebuild the Windows build</span>
              </div>
              <button
                onClick={() => copyToClipboard(REBUILD_COMMAND, 'rebuild')}
                className="flex items-center gap-1 px-2.5 py-1 text-xs text-neutral-400 hover:text-white rounded hover:bg-neutral-800 transition-colors"
              >
                {copied === 'rebuild' ? (
                  <>
                    <Check className="w-3 h-3 text-emerald-400" />
                    <span className="text-emerald-400">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    <span>Copy</span>
                  </>
                )}
              </button>
            </div>
            <div className="p-2.5 bg-neutral-900 border border-neutral-800 rounded-lg font-mono text-[11px] text-emerald-400 select-all overflow-x-auto">
              {REBUILD_COMMAND}
            </div>
            <p className="text-[11px] text-neutral-400 leading-relaxed">
              Run this from {repoRoot}. It rebuilds <code className="text-white">dist\</code> and
              regenerates the Electron package in <code className="text-white">dist-desktop\</code>.
            </p>
            <div className="flex items-center gap-2 text-[11px] text-neutral-500">
              <FolderOpen className="w-3.5 h-3.5" />
              <span>No installer download or C# compiler is required.</span>
            </div>
          </div>

          <div className="flex items-start gap-2 text-[11px] text-neutral-500 leading-relaxed px-1">
            <Layers className="w-3.5 h-3.5 text-purple-400 shrink-0 mt-0.5" />
            <span>
              Both desktop paths use the same local Ollama daemon at{' '}
              <code className="text-neutral-400">localhost:11434</code>. Nothing is uploaded.
            </span>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-4 border-t border-neutral-800 shrink-0">
          <div className="text-[11px] text-neutral-400 font-mono">
            Target OS: Windows 10 / Windows 11 (x64)
          </div>
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-neutral-900 bg-white hover:bg-neutral-100 rounded-lg transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
