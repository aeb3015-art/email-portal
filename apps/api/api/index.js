// Vercel function entry: the whole Express app, compiled to dist/ at build time.
import { createApp } from '../dist/app.js';

export default createApp();
