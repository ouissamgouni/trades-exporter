
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ColorModeProvider } from './components/ui/color-mode';
import './index.css';

const root = createRoot(document.getElementById('root')!);
root.render(
    <BrowserRouter>
        <ColorModeProvider defaultTheme="light" enableSystem={false}>
            <App />
        </ColorModeProvider>
    </BrowserRouter>
);
