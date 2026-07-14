
import { createRoot } from 'react-dom/client';
import App from './App';
import { ColorModeProvider } from './components/ui/color-mode';
import './index.css';

const root = createRoot(document.getElementById('root')!);
root.render(
    <ColorModeProvider defaultTheme="light" enableSystem={false}>
        <App />
    </ColorModeProvider>
);
