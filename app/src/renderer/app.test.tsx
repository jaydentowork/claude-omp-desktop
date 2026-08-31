import { render } from '@testing-library/react';
import { App } from './app';

describe('scaffold shell', () => {
  it('renders the titlebar drag region', () => {
    const { container } = render(<App />);
    expect(container.querySelector('.titlebar')).toBeInTheDocument();
  });
});