import { useEffect, useRef, useState } from 'react';

/**
 * FR-RORD-001: a repeating alert while new orders wait. Browsers only allow
 * audio after a user gesture, so staff press "Start receiving orders" once.
 */
export function useOrderAlert(active: boolean) {
  const [enabled, setEnabled] = useState(false);
  const ctx = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (!enabled || !active || !ctx.current) return;
    const audio = ctx.current;
    const beep = () => {
      for (const [i, f] of [880, 660].entries()) {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.frequency.value = f;
        gain.gain.value = 0.2;
        osc.connect(gain).connect(audio.destination);
        const t = audio.currentTime + i * 0.25;
        osc.start(t);
        osc.stop(t + 0.2);
      }
    };
    beep();
    const timer = setInterval(beep, 2500);
    return () => clearInterval(timer);
  }, [enabled, active]);

  return {
    enabled,
    enable() {
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AC) {
        ctx.current ??= new AC();
        void ctx.current.resume();
      }
      setEnabled(true);
    },
    disable: () => setEnabled(false),
  };
}
