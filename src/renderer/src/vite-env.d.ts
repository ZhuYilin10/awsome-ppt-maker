/// <reference types="vite/client" />
import type { DesktopAPI } from '../../shared/project';
declare global { interface Window { pptPlan?: DesktopAPI } }
export {};
