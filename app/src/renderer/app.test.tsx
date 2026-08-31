import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './app';
import { OmpProvider } from './omp-provider';

describe('scaffold shell', () => {
  it('renders the drag region and the transcript pane', () => {
    const { container } = render(
      <OmpProvider>
        <App />
      </OmpProvider>,
    );
    expect(container.querySelector('.titlebar')).not.toBeNull();
    expect(container.querySelector('.transcript-pane')).not.toBeNull();
  });
});