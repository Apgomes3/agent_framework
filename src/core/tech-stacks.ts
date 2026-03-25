/**
 * Tech stack plugin architecture.
 *
 * Each TechStack defines the coder prompt, default dependencies, designer hints,
 * and QA awareness for a specific tech combination. The active stack is selected
 * via the `stack` field in agent-framework.config.json.
 */

export interface TechStack {
  /** Unique identifier (used in config) */
  id: string;
  /** Display name */
  name: string;
  /** Coder system prompt — tech-specific coding rules and output format */
  coderSystemPrompt: string;
  /** Designer system prompt override (merged with base) */
  designerHints: string;
  /** QA scaffold awareness extra rules */
  qaHints: string;
  /** Default production dependencies */
  defaultDependencies: Record<string, string>;
  /** Default dev dependencies */
  defaultDevDependencies: Record<string, string>;
  /** Build script (used in package.json) */
  buildScript: string;
  /** Dev script */
  devScript: string;
}

// ── Built-in stacks ──────────────────────────────────────

const REACT_FLUENT: TechStack = {
  id: "react-fluent",
  name: "React 19 + Vite + Fluent UI",
  coderSystemPrompt: `You are a senior full-stack TypeScript developer. Your job is to generate production-quality source code for a React + Express web application.

## Tech Stack
- Frontend: React 19, TypeScript, Vite, **@vitejs/plugin-react** (always include in devDependencies), Fluent UI (@fluentui/react-components), Zustand, React Hook Form + Zod, TanStack Query, React Router DOM
- Backend: Express.js with TypeScript, Zod request validation
- Testing: Vitest (unit), Playwright (e2e)

## Code quality rules
- Strict TypeScript (no \`any\`)
- Functional components with hooks only
- Every page/component file must have a default export — never use only named exports for components imported in routing or App.tsx
- Proper error boundaries
- Loading and error states for async operations
- Accessible markup (semantic HTML, ARIA)
- Input validation with Zod at API boundaries
- Structured folders: features/, components/, hooks/, stores/, api/, types/
- Barrel exports (index.ts per folder)
- Environment variables via import.meta.env (frontend) and process.env (backend)`,
  designerHints: `Use Fluent UI components (DataGrid, CommandBar, Panel, Dialog, Pivot, MessageBar). Role-based views. Accessible and consistent spacing.`,
  qaHints: `This project uses React 19 + Fluent UI + Vite. Check for @vitejs/plugin-react in devDependencies. Verify Fluent UI imports use @fluentui/react-components.`,
  defaultDependencies: {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.0.0",
    "@fluentui/react-components": "^9.56.0",
    "zustand": "^5.0.0",
    "react-hook-form": "^7.54.0",
    "zod": "^3.24.0",
    "@hookform/resolvers": "^4.1.0",
    "@tanstack/react-query": "^5.70.0",
  },
  defaultDevDependencies: {
    "typescript": "^5.7.0",
    "vite": "^6.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vitest": "^3.0.0",
    "@playwright/test": "^1.50.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
  },
  buildScript: "tsc -b && vite build",
  devScript: "vite",
};

const NEXTJS: TechStack = {
  id: "nextjs",
  name: "Next.js 15 + App Router + shadcn/ui",
  coderSystemPrompt: `You are a senior full-stack TypeScript developer. Your job is to generate production-quality source code for a Next.js application.

## Tech Stack
- Framework: Next.js 15 with App Router, TypeScript
- UI: shadcn/ui components (Radix UI primitives + Tailwind CSS)
- State: Zustand for client state, Server Actions for mutations
- Forms: React Hook Form + Zod
- Data: TanStack Query for client, server components for initial load
- Styling: Tailwind CSS
- Testing: Vitest (unit), Playwright (e2e)

## Code quality rules
- Use server components by default; add "use client" only when needed
- Collocate page.tsx, layout.tsx, loading.tsx, error.tsx per route
- Strict TypeScript (no \`any\`)
- Use Next.js conventions: app/ folder structure, route groups, parallel routes
- Accessible markup (semantic HTML, ARIA)
- Input validation with Zod at API boundaries (Server Actions)
- Structured folders: app/, components/, lib/, hooks/, types/
- Environment variables via process.env (server) and NEXT_PUBLIC_ (client)`,
  designerHints: `Use shadcn/ui components (DataTable, Sheet, Dialog, Command, Tabs). Tailwind utility classes for spacing. Dark/light mode support via next-themes.`,
  qaHints: `This project uses Next.js 15 App Router. Verify "use client" directives are present on client components. Check that server components don't use useState/useEffect. Verify next.config.ts exists.`,
  defaultDependencies: {
    "next": "^15.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zustand": "^5.0.0",
    "react-hook-form": "^7.54.0",
    "zod": "^3.24.0",
    "@hookform/resolvers": "^4.1.0",
    "@tanstack/react-query": "^5.70.0",
    "class-variance-authority": "^0.7.0",
    "clsx": "^2.1.0",
    "tailwind-merge": "^2.6.0",
    "lucide-react": "^0.470.0",
  },
  defaultDevDependencies: {
    "typescript": "^5.7.0",
    "tailwindcss": "^4.0.0",
    "@tailwindcss/postcss": "^4.0.0",
    "vitest": "^3.0.0",
    "@playwright/test": "^1.50.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
  },
  buildScript: "next build",
  devScript: "next dev",
};

const VUE_FASTIFY: TechStack = {
  id: "vue-fastify",
  name: "Vue 3 + Vite + Fastify",
  coderSystemPrompt: `You are a senior full-stack TypeScript developer. Your job is to generate production-quality source code for a Vue 3 + Fastify web application.

## Tech Stack
- Frontend: Vue 3 (Composition API), TypeScript, Vite, PrimeVue or Vuetify, Pinia (state), VeeValidate + Zod, Vue Router
- Backend: Fastify with TypeScript, Zod request validation, @fastify/cors, @fastify/sensible
- Testing: Vitest (unit), Playwright (e2e)

## Code quality rules
- Strict TypeScript (no \`any\`)
- Use <script setup lang="ts"> in all SFCs
- Composition API only (no Options API)
- Accessible markup (semantic HTML, ARIA)
- Input validation with Zod at API boundaries
- Structured folders: src/views/, src/components/, src/composables/, src/stores/, src/api/, src/types/
- Environment variables via import.meta.env (frontend) and process.env (backend)`,
  designerHints: `Use PrimeVue or Vuetify components. Vue 3 SFC structure. Composables for reusable logic.`,
  qaHints: `This project uses Vue 3 + Fastify. Check that SFCs use <script setup lang="ts">. Verify Pinia stores use defineStore(). Check Fastify route schemas.`,
  defaultDependencies: {
    "vue": "^3.5.0",
    "vue-router": "^4.5.0",
    "pinia": "^3.0.0",
    "zod": "^3.24.0",
  },
  defaultDevDependencies: {
    "typescript": "^5.7.0",
    "vite": "^6.0.0",
    "@vitejs/plugin-vue": "^5.2.0",
    "vitest": "^3.0.0",
    "@playwright/test": "^1.50.0",
    "vue-tsc": "^2.2.0",
  },
  buildScript: "vue-tsc -b && vite build",
  devScript: "vite",
};

// ── Registry ─────────────────────────────────────────────

const STACK_REGISTRY = new Map<string, TechStack>([
  ["react-fluent", REACT_FLUENT],
  ["nextjs", NEXTJS],
  ["vue-fastify", VUE_FASTIFY],
]);

/**
 * Get a tech stack by ID. Falls back to "react-fluent" if not found,
 * but warns when an unknown ID is provided.
 */
export function getTechStack(id?: string): TechStack {
  if (!id) return REACT_FLUENT;
  const stack = STACK_REGISTRY.get(id);
  if (!stack) {
    const available = Array.from(STACK_REGISTRY.keys()).join(", ");
    console.warn(`[tech-stack] Unknown stack "${id}" — falling back to "react-fluent". Available: ${available}`);
    return REACT_FLUENT;
  }
  return stack;
}

/**
 * List all available stack IDs.
 */
export function listTechStacks(): string[] {
  return Array.from(STACK_REGISTRY.keys());
}
