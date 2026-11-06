/**
 * Where every setting lives (the operator, 2026-11-04: "make sure there are no buried settings that are nested"). A
 * setting sits on the place it belongs to, or on the one Settings window, and never in a window opened from a shelf or
 * from another window. settingsMap.test.ts holds the components to this list: each is rendered in its file(s) and
 * nowhere else.
 *
 * `clicks`: from the window as it opens, the fewest clicks to reach it.
 */
export interface SettingPlace {
  /** the component that holds the controls */
  control: string;
  /** the file that renders it (more than one only where the place itself is twofold) */
  files: string[];
  place: string;
  clicks: number;
}

export const SETTINGS: SettingPlace[] = [
  { control: 'SpeakToggle', files: ['AgentView.tsx', 'PhoneView.tsx'], place: 'Agent tab and Phone view headers (read aloud on/off)', clicks: 1 },
  { control: 'TelegramSection', files: ['PhoneView.tsx'], place: 'Phone view → Setup', clicks: 2 },
  { control: 'WhatsAppSection', files: ['PhoneView.tsx'], place: 'Phone view → Setup', clicks: 2 },
  { control: 'DiscordSection', files: ['PhoneView.tsx'], place: 'Phone view → Setup', clicks: 2 },
  { control: 'OllamaSection', files: ['SettingsModal.tsx'], place: 'Settings → Ollama', clicks: 1 },
  { control: 'IntegrationsSection', files: ['SettingsModal.tsx'], place: 'Settings → Integrations', clicks: 1 },
  { control: 'VoiceSection', files: ['SettingsModal.tsx'], place: 'Settings → Voice', clicks: 1 },
  { control: 'ReportBack', files: ['SettingsModal.tsx'], place: 'Settings → Inbox from Claude', clicks: 1 },
  { control: 'AtlasSection', files: ['AgentConsole.tsx'], place: 'Agent tab → Console → Servers', clicks: 2 },
  { control: 'TerminalSection', files: ['AgentConsole.tsx'], place: 'Agent tab → Console → Tools', clicks: 2 },
  { control: 'BrowserSection', files: ['AgentConsole.tsx'], place: 'Agent tab → Console → Tools', clicks: 2 },
  { control: 'ComputerSection', files: ['AgentConsole.tsx'], place: 'Agent tab → Console → Tools', clicks: 2 },
  { control: 'CheckSection', files: ['AgentConsole.tsx'], place: 'Agent tab → Console → Tools', clicks: 2 },
  { control: 'TransportSection', files: ['AgentConsole.tsx'], place: 'Agent tab → Console → Tools', clicks: 2 },
  { control: 'McpSection', files: ['AgentConsole.tsx'], place: 'Agent tab → Console → Tools', clicks: 2 },
  { control: 'AutomationsSection', files: ['FlowsShelf.tsx'], place: 'Flows shelf → Set up', clicks: 2 },
];

/** The speaker: flips voice.speakReplies, and turning it off stops what is being read now. Returns the new value. */
export function flipSpeak(on: boolean, update: (v: { speakReplies: boolean }) => void, stop: () => void): boolean {
  const next = !on;
  update({ speakReplies: next });
  if (!next) stop();
  return next;
}
