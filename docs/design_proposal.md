# Red Shrimp Lab UI Refresh: Design Proposal

This document outlines the design direction for a UI refresh of the Red Shrimp Lab application. The goal is to move from the current retro, pixelated aesthetic to a modern, clean, and professional interface inspired by Apple's design language.

## 1. Core Principles

- **Clarity:** The UI should be intuitive and easy to navigate.
- **Consistency:** A consistent design language will be applied across the entire application.
- **Modern Aesthetic:** We will adopt a modern look and feel, characterized by clean lines, soft shadows, and subtle animations.

## 2. Color Palette

The new color palette will be based on a dark, cool background with vibrant accents.

- **Primary Background:** A subtle gradient from a deep blue (`#0D1117`) to a slightly lighter blue (`#161B22`).
- **Secondary Background (Panels/Modals):** A semi-transparent white with a background blur effect (`rgba(22, 27, 34, 0.8)`).
- **Primary Accent:** A vibrant blue (`#58A6FF`) for interactive elements, links, and highlights.
- **Secondary Accent (Success/Online):** A bright green (`#3FB950`).
- **Destructive Accent (Errors/Delete):** A noticeable red (`#F85149`).
- **Text (Primary):** A light grey (`#E6EDF3`) for body text.
- **Text (Secondary):** A medium grey (`#8B949E`) for less important text and labels.

| Color | Hex | Usage |
|---|---|---|
| Deep Blue | `#0D1117` | Background Gradient Start |
| Lighter Blue | `#161B22` | Background Gradient End |
| Panel BG | `rgba(22, 27, 34, 0.8)` | Panels and Modals |
| Accent Blue | `#58A6FF` | Interactive Elements |
| Accent Green | `#3FB950` | Success, Online Status |
| Accent Red | `#F85149` | Errors, Destructive Actions |
| Primary Text | `#E6EDF3` | Main content |
| Secondary Text | `#8B949E` | Labels, secondary info |

## 3. Typography

We will replace the current `Share Tech Mono` with a modern, sans-serif font family.

- **Font Family:** `Inter`, with `SF Pro` and system sans-serif fonts as fallbacks.
- **Body Text:** 14px, regular weight.
- **Headings (h1):** 24px, bold weight.
- **Headings (h2):** 20px, bold weight.
- **Headings (h3):** 16px, bold weight.
- **Labels:** 12px, medium weight, uppercase.

## 4. Spacing, Borders, and Shadows

- **Spacing:** A 4px grid system will be used for all margins, paddings, and layout. (e.g., 4px, 8px, 12px, 16px, 24px, 32px).
- **Borders:** The thick `3px solid #000` borders will be replaced with a subtle `1px solid rgba(255, 255, 255, 0.1)`.
- **Corner Radius:** A `8px` border-radius will be applied to most UI elements, including buttons, inputs, and panels.
- **Shadows:** The harsh `box-shadow` will be replaced with soft, layered shadows to create a sense of depth.
    - **Default Shadow:** `0px 4px 12px rgba(0, 0, 0, 0.2)`
    - **Hover Shadow:** `0px 6px 16px rgba(0, 0, 0, 0.3)`

## 5. Component Redesign

### Buttons

- **Primary Button:** Solid accent blue background, white text, 8px corner radius.
- **Secondary Button:** Semi-transparent white background with blue border and text.
- **Destructive Button:** Solid accent red background, white text.

### Inputs & Textareas

- Semi-transparent white background, 1px subtle border, 8px corner radius.
- On focus, the border will be highlighted with the primary accent blue.

### Panels & Modals

- Semi-transparent white background with a backdrop blur effect.
- `1px` subtle border and `16px` corner radius.
- Soft shadow to lift it off the background.

## 6. Page-by-Page Changes

### ChannelsView

- The main content area will have the new dark blue gradient background.
- The channel list and right sidebar will have the semi-transparent panel background with a backdrop blur.
- Message bubbles will be updated with the new colors and have a softer appearance with `12px` border-radius.
- The `3px` black borders will be removed and replaced with the new subtle borders.

### LoginPage

- The login form will be centered on the page with the new gradient background.
- The form itself will be a panel with the new blurred background, rounded corners, and soft shadows.

### Other Pages

All other pages (AgentsPage, HomePage, TasksBoard, SettingsPage) will be updated to use the new design system, ensuring a consistent look and feel across the application.

## 7. Implementation Plan

1.  **Update `index.css`:**
    -   Change the `body` background and font-family.
    -   Replace the `.rsl-control`, `.rsl-popover`, and other custom component styles with the new design.
2.  **Refactor Components:**
    -   Update individual React components to use the new styles. This may involve changing class names and removing inline styles.
3.  **Iterate and Refine:**
    -   After the initial implementation, we will conduct a design review to identify any inconsistencies and make necessary refinements.
