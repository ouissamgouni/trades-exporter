
import { ChakraProvider, defaultSystem } from '@chakra-ui/react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ColorModeProvider } from './components/ui/color-mode';
import './index.css';

const root = createRoot(document.getElementById('root')!);
root.render(
    <ChakraProvider value={defaultSystem}>
        <ColorModeProvider defaultTheme="light" enableSystem={false}>
            <App />
        </ColorModeProvider>
    </ChakraProvider>
);
