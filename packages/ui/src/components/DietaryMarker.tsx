import { cn } from '../cn';

export type DietaryMarkerType = 'VEG' | 'NON_VEG' | 'EGG';

const LABELS: Record<DietaryMarkerType, string> = {
  VEG: 'Vegetarian',
  NON_VEG: 'Non-vegetarian',
  EGG: 'Contains egg',
};

const COLOR: Record<DietaryMarkerType, string> = {
  VEG: 'border-veg text-veg',
  NON_VEG: 'border-nonveg text-nonveg',
  EGG: 'border-egg text-egg',
};

const SIZES = { sm: 12, md: 16, lg: 20 } as const;

/**
 * Veg / non-veg / egg marker (UI-DS-005, NFR-ACCESS-004). Meaning is conveyed by
 * shape (dot vs triangle) and an accessible label, not by colour alone.
 */
export function DietaryMarker({
  type,
  size = 'md',
  className,
}: {
  type: DietaryMarkerType;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const px = SIZES[size];
  return (
    <span
      role="img"
      aria-label={LABELS[type]}
      title={LABELS[type]}
      data-marker={type}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[2px] border-[1.5px]',
        COLOR[type],
        className,
      )}
      style={{ width: px, height: px }}
    >
      <svg
        viewBox="0 0 10 10"
        width={px * 0.55}
        height={px * 0.55}
        aria-hidden="true"
        fill="currentColor"
      >
        {type === 'NON_VEG' ? (
          <polygon points="5,1 9.5,9 0.5,9" />
        ) : (
          <circle cx="5" cy="5" r="4.5" />
        )}
      </svg>
    </span>
  );
}
