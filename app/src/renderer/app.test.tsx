import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './app';

describe('scaffold shell', () => {
  it('renders the drag region', () => {
    const { container } = render(<App />);
    expect(container.querySelector('.titlebar')).not.toBeNull();
  });
});
