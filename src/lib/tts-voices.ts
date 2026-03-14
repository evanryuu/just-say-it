/** Language prefix → Edge TTS neural voice name */
const VOICE_MAP: Record<string, string> = {
  'zh': 'zh-CN-XiaoxiaoNeural',
  'en': 'en-US-JennyNeural',
  'ja': 'ja-JP-NanamiNeural',
  'ko': 'ko-KR-SunHiNeural',
  'fr': 'fr-FR-DeniseNeural',
  'de': 'de-DE-KatjaNeural',
  'es': 'es-ES-ElviraNeural',
  'pt': 'pt-BR-FranciscaNeural',
  'ru': 'ru-RU-SvetlanaNeural',
  'ar': 'ar-SA-ZariyahNeural',
};

const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

export function getVoiceForLang(lang?: string): string {
  if (!lang) return DEFAULT_VOICE;
  // Try full match first (e.g. "zh-CN"), then prefix (e.g. "zh")
  const prefix = lang.slice(0, 2).toLowerCase();
  return VOICE_MAP[prefix] ?? DEFAULT_VOICE;
}
