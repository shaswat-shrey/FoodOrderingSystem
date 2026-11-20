import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from './Button';
import { DietaryMarker } from './DietaryMarker';
import { ErrorState } from './StatusMessage';

describe('DietaryMarker (UI-DS-005, NFR-ACCESS-004)', () => {
  it.each([
    ['VEG', 'Vegetarian', 'circle'],
    ['EGG', 'Contains egg', 'circle'],
    ['NON_VEG', 'Non-vegetarian', 'polygon'],
  ] as const)('%s has a text alternative and a distinct shape', (type, label, shape) => {
    const { container } = render(<DietaryMarker type={type} />);
    expect(screen.getByRole('img', { name: label })).toBeInTheDocument();
    expect(container.querySelector(shape)).not.toBeNull();
  });
});

describe('Button', () => {
  it('is disabled and busy while loading', () => {
    render(<Button loading>Place order</Button>);
    const button = screen.getByRole('button', { name: /place order/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });

  it('defaults to type="button" so it never submits forms by accident', () => {
    render(<Button>Cancel</Button>);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute('type', 'button');
  });
});

describe('ErrorState', () => {
  it('is announced to assistive technology', () => {
    render(<ErrorState title="Couldn't load restaurants" />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load restaurants");
  });
});
