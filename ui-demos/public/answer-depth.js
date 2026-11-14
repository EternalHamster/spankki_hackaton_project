// One browser-wide preference for observations, summaries and new chat answers.
// Individual answer rewrites do not change it.
export const LEVELS = [
  { id: 'simple', label: 'Selkeä', description: 'Lyhyesti ja arkikielellä, ilman lukujen pyörittelyä.' },
  { id: 'standard', label: 'Perus', description: 'Tärkeimmät luvut, yksi vertailu ja syy lyhyesti.' },
  { id: 'detailed', label: 'Syvällinen', description: 'Luvut, vertailut ja miten arviot muodostuvat.' },
];
export const LEVEL_KEY = 'oma-talous-vastaustaso';
export const levelIndex = id => LEVELS.findIndex(level => level.id === id);

export function createAnswerDepthSettings({ storage = () => globalThis.localStorage } = {}) {
  let fallback = 'standard', unsaved = false;
  return {
    get() {
      // If writing is blocked, the latest choice still applies for this visit.
      if (unsaved) return fallback;
      try {
        const saved = storage().getItem(LEVEL_KEY);
        fallback = levelIndex(saved) >= 0 ? saved : 'standard';
      } catch { /* Keep the last known choice if reading becomes unavailable. */ }
      return fallback;
    },
    set(id) {
      if (levelIndex(id) < 0) throw new RangeError('Unknown answer depth');
      fallback = id;
      try {
        storage().setItem(LEVEL_KEY, id);
        unsaved = false;
        return { level: id, persisted: true };
      } catch {
        unsaved = true;
        return { level: id, persisted: false };
      }
    },
  };
}

const settings = createAnswerDepthSettings();
export const getAnswerLevel = () => settings.get();
export const setAnswerLevel = id => settings.set(id);
