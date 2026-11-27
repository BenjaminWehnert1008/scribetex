import { Monitor, Moon, Palette, Sun } from 'lucide-react';
import { useState } from 'react';
import { ACCENTS, nextTheme, readAccent, readTheme, saveAccent, saveTheme, type AccentChoice, type ThemeChoice } from '@/app/theme';
import { Menu } from './ui';

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

/** A button that opens the list of colour schemes (green, blue, ..., black and white). */
export function AccentSwitch(props: { withLabel?: boolean }) {
  const [choice, setChoice] = useState<AccentChoice>(readAccent);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const current = ACCENTS.find((accent) => accent.id === choice) ?? ACCENTS[0];
  return (
    <>
      <button
        className={props.withLabel ? 'theme-switch' : 'icon-btn'}
        title={`Colour scheme: ${current.label}`}
        aria-label={`Colour scheme: ${current.label}`}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setMenu({ x: props.withLabel ? box.left : box.right - 200, y: box.bottom + 4 });
        }}
      >
        <Palette size={props.withLabel ? 13 : 16} />
        {props.withLabel && <span>{current.label}</span>}
      </button>
      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={ACCENTS.map((accent) => ({
            label: accent.label,
            icon: <span className="swatch" style={{ background: accent.swatch }} aria-hidden />,
            checked: accent.id === choice,
            run: () => {
              saveAccent(accent.id);
              setChoice(accent.id);
            },
          }))}
        />
      )}
    </>
  );
}
