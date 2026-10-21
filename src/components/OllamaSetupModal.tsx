import React, { useState } from 'react';
import { OllamaConfig } from '../types/index.ts';
import { checkOllamaConnection, DEFAULT_OLLAMA_HOST, DEFAULT_OLLAMA_MODEL } from '../utils/ollama.ts';
import { X, CheckCircle2, AlertCircle, RefreshCw, Copy, Check, Terminal, ExternalLink, Cpu } from 'lucide-react';

interface OllamaSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: OllamaConfig;
  onUpdateConfig: (newConfig: Partial<OllamaConfig>) => void;
}

export const OllamaSetupModal: React.FC<OllamaSetupModalProps> = ({
  isOpen,
  onClose,
  config,
  onUpdateConfig,
}) => {
  const [hostUrl, setHostUrl] = useState(config.hostUrl || DEFAULT_OLLAMA_HOST);
  const [model, setModel] = useState(config.model || DEFAULT_OLLAMA_MODEL);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success?: boolean;
    pingMs?: number;
    models?: string[];
    message?: string;
  } | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  if (!isOpen) return null;

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);

    const result = await checkOllamaConnection(hostUrl);
    setIsTesting(false);

    if (result.isConnected) {
      const detectedModels = result.models.length > 0 ? result.models : [DEFAULT_OLLAMA_MODEL];
      setTestResult({
        success: true,
        pingMs: result.pingMs,
        models: result.models,
        message: `Connected successfully! Latency: ${result.pingMs}ms. Found ${result.models.length} local model(s).`,
      });
      onUpdateConfig({
        hostUrl,
        isConnected: true,
        lastPingMs: result.pingMs,
        availableModels: detectedModels,
      });
    } else {
      setTestResult({
        success: false,
        pingMs: result.pingMs,
        message: result.error || 'Connection failed. Check if Ollama desktop is running and CORS is enabled.',
      });
      onUpdateConfig({
        isConnected: false,
        lastPingMs: result.pingMs,
      });
    }
  };

  const copyToClipboard = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const setupCommands = [
    {
      label: '1. Launch Ollama with Web CORS Allowed',
      cmd: 'OLLAMA_ORIGINS="*" ollama serve',
      note: 'Crucial for web browsers to communicate with local Ollama daemon.',
    },
    {
      label: '2. Verify or Pull GPT-OSS 20B',
      cmd: 'ollama run gpt-oss:20b',
      note: 'Downloads and starts the model if not already present on disk.',
    },
    {
      label: '3. macOS Persistent Environment (Optional)',
      cmd: 'launchctl setenv OLLAMA_ORIGINS "*"',
      note: 'Ensures Ollama GUI app always permits local browser requests upon reboot.',
    },
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="ollama-setup-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-150"
    >
      <div className="relative w-full max-w-2xl bg-neutral-900 border border-neutral-800 rounded-xl shadow-2xl p-6 overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-neutral-800 shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-neutral-800 border border-neutral-700 text-neutral-200">
              <Cpu className="w-5 h-5 text-emerald-400" />
            </div>
            <div>
              <h2 id="ollama-setup-title" className="text-lg font-bold text-white tracking-tight">
                Local Ollama & GPT-OSS:20B Setup
              </h2>
              <p className="text-xs text-neutral-400">
                100% private, zero-telemetry local inference on your desktop
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close setup modal"
            className="p-1.5 text-neutral-400 hover:text-white rounded-lg hover:bg-neutral-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto py-5 space-y-6 pr-1">
          {/* Status Banner */}
          <div
            className={`p-4 rounded-lg border flex items-start gap-3 text-sm ${
              config.isConnected
                ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'
                : 'bg-neutral-800/60 border-neutral-700 text-neutral-300'
            }`}
          >
            {config.isConnected ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
            ) : (
              <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            )}
            <div className="space-y-1">
              <div className="font-semibold text-white">
                {config.isConnected
                  ? `Active Connection: Local Ollama Desktop (${config.lastPingMs || 12}ms)`
                  : 'Ollama Desktop Connection Pending'}
              </div>
              <p className="text-xs opacity-90 leading-relaxed">
                {config.isConnected
                  ? `Connected to local daemon at ${config.hostUrl}. Synthesis requests will execute locally via ${config.model}.`
                  : 'Your browser cannot connect directly to Ollama at the default port (11434). Run Ollama with OLLAMA_ORIGINS="*" enabled, or enable Simulation Mode below to test immediately.'}
              </p>
            </div>
          </div>

          {/* Configuration Inputs */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="ollama-host" className="block text-xs font-semibold text-neutral-300 mb-1.5">
                Ollama Endpoint URL
              </label>
              <input
                id="ollama-host"
                type="text"
                value={hostUrl}
                onChange={(e) => setHostUrl(e.target.value)}
                placeholder="http://localhost:11434"
                className="w-full px-3 py-2 bg-neutral-950 border border-neutral-700 rounded-lg text-sm text-white placeholder-neutral-500 focus:outline-none focus:border-neutral-500 font-mono text-xs"
              />
            </div>

            <div>
              <label htmlFor="ollama-model" className="block text-xs font-semibold text-neutral-300 mb-1.5">
                Target Model Name
              </label>
              {config.availableModels && config.availableModels.length > 0 ? (
                <div className="relative">
                  <select
                    id="ollama-model"
                    value={model}
                    onChange={(e) => {
                      setModel(e.target.value);
                      onUpdateConfig({ model: e.target.value });
                    }}
                    className="w-full px-3 py-2 bg-neutral-950 border border-neutral-700 rounded-lg text-sm text-white focus:outline-none focus:border-neutral-500 font-mono text-xs"
                  >
                    {config.availableModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                    {!config.availableModels.includes(model) && (
                      <option value={model}>{model} (custom)</option>
                    )}
                  </select>
                </div>
              ) : (
                <input
                  id="ollama-model"
                  type="text"
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value);
                    onUpdateConfig({ model: e.target.value });
                  }}
                  placeholder="gpt-oss:20b"
                  className="w-full px-3 py-2 bg-neutral-950 border border-neutral-700 rounded-lg text-sm text-white placeholder-neutral-500 focus:outline-none focus:border-neutral-500 font-mono text-xs"
                />
              )}
            </div>
          </div>

          {/* Test & Simulation Controls */}
          <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-neutral-950 border border-neutral-800 rounded-lg">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="simulated-mode"
                checked={config.isSimulatedMode}
                onChange={(e) => onUpdateConfig({ isSimulatedMode: e.target.checked })}
                className="rounded border-neutral-700 bg-neutral-900 text-neutral-200 focus:ring-0 w-4 h-4 cursor-pointer"
              />
              <label htmlFor="simulated-mode" className="text-xs text-neutral-300 font-medium cursor-pointer">
                Offline Simulation Mode (Test UI without running Ollama)
              </label>
            </div>

            <button
              onClick={handleTestConnection}
              disabled={isTesting}
              className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-white bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-lg transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isTesting ? 'animate-spin' : ''}`} />
              {isTesting ? 'Pinging Localhost...' : 'Test Connection'}
            </button>
          </div>

          {/* Diagnostic Test Feedback */}
          {testResult && (
            <div
              className={`p-3 rounded-lg border text-xs leading-relaxed ${
                testResult.success
                  ? 'bg-emerald-950/30 border-emerald-800/50 text-emerald-300'
                  : 'bg-rose-950/30 border-rose-800/50 text-rose-300'
              }`}
            >
              <div className="font-semibold mb-1">
                {testResult.success ? 'Diagnostics Passed' : 'Diagnostics Failed'}
              </div>
              <p>{testResult.message}</p>
              {testResult.models && testResult.models.length > 0 && (
                <div className="mt-2 text-neutral-300">
                  <span className="font-medium text-neutral-400">Available local models: </span>
                  {testResult.models.join(', ')}
                </div>
              )}
            </div>
          )}

          {/* Setup Terminal Guide */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs font-bold text-neutral-300 uppercase tracking-wider">
              <Terminal className="w-3.5 h-3.5 text-neutral-400" />
              <span>Quick Terminal Commands</span>
            </div>

            <div className="space-y-2.5">
              {setupCommands.map((item, idx) => (
                <div key={idx} className="p-3 bg-neutral-950 border border-neutral-800 rounded-lg space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-neutral-200">{item.label}</span>
                    <button
                      onClick={() => copyToClipboard(item.cmd, idx)}
                      aria-label={`Copy command ${item.cmd}`}
                      className="flex items-center gap-1 px-2 py-0.5 text-xs text-neutral-400 hover:text-white rounded hover:bg-neutral-800 transition-colors"
                    >
                      {copiedIndex === idx ? (
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
                  <div className="p-2 bg-neutral-900 border border-neutral-800 rounded font-mono text-xs text-emerald-400 select-all overflow-x-auto">
                    {item.cmd}
                  </div>
                  <p className="text-[11px] text-neutral-400">{item.note}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-4 border-t border-neutral-800 shrink-0">
          <a
            href="https://ollama.com/library"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-200 transition-colors"
          >
            <span>Ollama Model Library</span>
            <ExternalLink className="w-3 h-3" />
          </a>
          <button
            onClick={() => {
              onUpdateConfig({ hostUrl, model });
              onClose();
            }}
            className="px-4 py-2 text-xs font-semibold text-neutral-900 bg-white hover:bg-neutral-100 rounded-lg transition-colors"
          >
            Save & Close
          </button>
        </div>
      </div>
    </div>
  );
};
