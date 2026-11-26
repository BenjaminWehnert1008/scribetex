import { Monitor, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { nextTheme, readTheme, saveTheme, type ThemeChoice } from '@/app/theme';

const LABEL: Record<ThemeChoice, string> = { system: 'Same as system', light: 'Light', dark: 'Dark' };

/** One button that cycles the colour mode: same as system, light, dark. */
export function ThemeSwitch(props: { withLabel?: boolean }) {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);
  const next = nextTheme(choice);
  const Icon = choice === 'light' ? Sun : choice === 'dark' ? Moon : Monitor;
  return (
    <button
      className={props.withLabel ? 'theme-switch' : 'icon-btn'}
      title={`Colour mode: ${LABEL[choice]}. Click for ${LABEL[next].toLowerCase()}.`}
      aria-label={`Colour mode: ${LABEL[choice]}`}
      onClick={() => {
        saveTheme(next);
        setChoice(next);
      }}
    >
      <Icon size={props.withLabel ? 13 : 16} />
      {props.withLabel && <span>{LABEL[choice]}</span>}
    </button>
  );
}

/**
 * An image in fixed light and dark versions; CSS shows the one for the active
 * mode (an <img> cannot see the switch, only the system setting).
 */
export function ThemedImage(props: { name: string; alt: string; width: number; height: number; className?: string }) {
  return (
    <>
      {(['light', 'dark'] as const).map((mode) => (
        <img
          key={mode}
          className={`${props.className ?? ''} only-${mode}`}
          src={`./${props.name}-${mode}.svg`}
          alt={props.alt}
          width={props.width}
          height={props.height}
        />
      ))}
    </>
  );
}
