# Markdown Viewer — UI/UX Design

**Requested by**: @Jwt2077
**Feature**: Optimize document viewing with structure + content layout
**Phase**: 2B (UI Enhancement)
**Owners**: @Astra (Design), @Alice (Implementation)

---

## Overview

Replace single-column markdown viewer with **responsive two-panel layout**:
- **Left Panel**: Document structure (TOC) — auto-generated from headings
- **Right Panel**: Document content — full markdown rendered
- **Responsive**: Adapts to window size (collapse TOC on small screens)

---

## Layout Design

### Desktop (1200px+)

```
┌─────────────────────────────────────────────────────────────┐
│ Red Shrimp Lab                              [← back] [...]  │
├──────────────────┬──────────────────────────────────────────┤
│                  │                                            │
│   TOC            │  Markdown Content                         │
│   ────────────   │  ──────────────────                       │
│                  │                                            │
│ • Heading 1      │  # Document Title                         │
│   ○ Heading 2    │  Some introduction text...                │
│   ○ Heading 2    │                                            │
│ • Heading 1      │  ## Section 1                             │
│   ○ Heading 2    │  Content for section 1                    │
│   ○ Heading 2    │                                            │
│                  │  ### Subsection                           │
│   [x] Link       │  More details...                          │
│                  │                                            │
│                  │                                            │
└──────────────────┴──────────────────────────────────────────┘
```

### Tablet (768px-1200px)

```
┌──────────────────────────────────────┐
│ [☰] Doc Title      [← back] [...]   │
├──────────────────────────────────────┤
│  [TOC ▼]                             │
│                                      │
│  # Document Title                    │
│  Some introduction text...           │
│                                      │
│  ## Section 1                        │
│  Content for section 1               │
│                                      │
│  ### Subsection                      │
│  More details...                     │
│                                      │
│                                      │
└──────────────────────────────────────┘
```

### Mobile (< 768px)

```
┌────────────────────────────┐
│ [☰] Doc  [← back] [...]   │
├────────────────────────────┤
│  # Document Title          │
│  Some intro...             │
│                            │
│  ## Section 1              │
│  Content for section 1     │
│                            │
│  ### Subsection            │
│  More details...           │
│                            │
└────────────────────────────┘

[TOC drawer opens when ☰ clicked]
```

---

## Component Specifications

### 1. TOC Sidebar (Left Panel)

**Desktop (1200px+)**:
- Width: 280px (fixed)
- Background: `#1a1a2e` (dark blue)
- Border: `3px solid #0f3460` (darker blue)
- Scrollable (max-height: 100vh)
- Padding: 16px

**Tablet/Mobile**:
- Collapsible drawer (off-canvas)
- Full height
- Slide-in from left
- Semi-transparent overlay behind

**TOC Structure**:
```
Document Structure
──────────────────

▸ Heading 1          [Blue highlight on hover]
  ○ Heading 2.1      [Indented, smaller text]
  ○ Heading 2.2
▸ Heading 1
  ○ Heading 2.1
  ○ Heading 2.2

[Scroll down if many headings]
```

**Styling**:
- H1: Bold, 16px, `#00d4ff` (cyan)
- H2: Regular, 14px, `#c1c1c1` (light gray)
- H3: Regular, 13px, `#999999` (medium gray)
- Active link: Background `#0f3460` + left border `3px #00d4ff`
- Hover: Background `rgba(15, 52, 96, 0.5)`

**Interactivity**:
- Click → Smooth scroll to section
- Active indicator → Highlight current section as user scrolls
- Click icon → Expand/collapse submenu (optional)

---

### 2. Content Panel (Right Panel)

**Desktop (1200px+)**:
- Flex: 1 (fills remaining space)
- Max-width: 900px (for readability)
- Padding: 40px
- Margin: 0 auto (centered)
- Scrollable

**Tablet (768px-1200px)**:
- Full width
- Padding: 20px
- Margin: 0

**Mobile (< 768px)**:
- Full width
- Padding: 16px
- Single column

**Markdown Rendering**:
- H1: 32px, bold, `#00d4ff`, 24px bottom margin
- H2: 24px, bold, `#ffffff`, 20px top, 16px bottom
- H3: 18px, bold, `#c1c1c1`, 16px top, 12px bottom
- P: 16px, `#e0e0e0`, 16px line-height, 12px bottom margin
- Code: Monospace, `#0f3460` background, `#00d4ff` text
- Links: `#00d4ff`, underline on hover
- Blockquote: Left border `3px #00d4ff`, `#999999` text, italic

**Layout**:
- Min-height: 100vh (full screen)
- Smooth scroll behavior
- Anchor links work (scroll to heading)

---

## Responsive Breakpoints

```css
/* Desktop */
@media (min-width: 1200px) {
  .container {
    display: flex;
    gap: 0;
  }
  .toc-sidebar {
    width: 280px;
    position: sticky;
    top: 0;
    height: 100vh;
    overflow-y: auto;
  }
  .content-panel {
    flex: 1;
    max-width: 900px;
    margin: 0 auto;
  }
}

/* Tablet */
@media (min-width: 768px) and (max-width: 1199px) {
  .toc-sidebar {
    display: none; /* Hidden, but accessible via button */
  }
  .toc-drawer {
    position: fixed;
    left: 0;
    top: 0;
    width: 280px;
    height: 100vh;
    z-index: 1000;
    transform: translateX(-100%);
    transition: transform 0.3s;
  }
  .toc-drawer.open {
    transform: translateX(0);
  }
  .toc-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 999;
  }
  .content-panel {
    width: 100%;
  }
}

/* Mobile */
@media (max-width: 767px) {
  /* Same as tablet, but TOC opener button always visible */
  .toc-button {
    display: block;
  }
}
```

---

## Header Bar (Unchanged)

```
┌────────────────────────────────────────┐
│ [☰ TOC] Filename.md  [← back] [⋯]    │
└────────────────────────────────────────┘
```

**Elements**:
- **[☰ TOC]**: Toggle button (only on tablet/mobile)
  - Click → Show/hide TOC drawer
  - Icon: 3 horizontal lines (hamburger)
  - Only visible < 1200px

- **Filename.md**: Document title
  - Truncate if too long
  - Use monospace font for `.md` extension

- **[← back]**: Go back to Docs list
  - Arrow icon + "back" text
  - Links to parent DocumentViewer

- **[⋯]**: Options menu (future)
  - Print
  - Download as PDF
  - Share
  - (Not implemented in Phase 2B)

---

## Scroll Behavior

### Desktop
- TOC sidebar: Sticky (stays visible while scrolling content)
- Content panel: Scrolls independently
- Active TOC link updates as user scrolls content

### Tablet/Mobile
- Content scrolls normally
- TOC drawer closes when document clicked (or click anchor)
- Back to top button (optional, bottom-right corner)

---

## Animations

**TOC Open/Close**:
- Drawer slides in from left: 0.3s ease-out
- Overlay fades in: 0.2s ease-out
- Click outside → close both

**Smooth Scroll**:
- Click TOC link → scroll to heading (smooth behavior)
- Duration: 0.5s

**Hover Effects**:
- TOC items: Subtle background change
- Links: Underline appears
- Buttons: Slight scale transform (1.05x)

---

## Implementation Checklist

### @Astra (Design Review)
- [ ] Validate color scheme (matches Red Shrimp Lab)
- [ ] Confirm responsive breakpoints
- [ ] Review typography sizing

### @Alice (Frontend Implementation)
- [ ] Extract headings from markdown (H1, H2, H3)
- [ ] Generate TOC structure from headings
- [ ] Implement sticky TOC sidebar (desktop)
- [ ] Implement collapsible TOC drawer (tablet/mobile)
- [ ] Add smooth scroll to headings
- [ ] Highlight active section in TOC during scroll
- [ ] Test responsive breakpoints
- [ ] Ensure accessibility (keyboard nav, screen readers)

### @Atlas (Testing)
- [ ] Test TOC generation with various markdown files
- [ ] Test responsive layout at different screen sizes
- [ ] Test scroll behavior and TOC highlighting
- [ ] Test keyboard navigation (Tab, Enter)
- [ ] Test on mobile/tablet devices

---

## Code Structure (Frontend)

```typescript
// DocumentViewer.tsx
export function DocumentViewer({ fileId }: Props) {
  const [isTocOpen, setIsTocOpen] = useState(false)
  const [activeHeading, setActiveHeading] = useState('')

  const headings = extractHeadings(markdownContent) // Parse markdown
  const toc = buildToc(headings) // Build tree structure

  return (
    <div className="document-viewer">
      <Header
        fileName={fileName}
        onToggleToc={() => setIsTocOpen(!isTocOpen)}
      />

      <div className="container">
        {/* Desktop TOC (sticky) */}
        <TocSidebar
          toc={toc}
          active={activeHeading}
          className="toc-desktop"
        />

        {/* Tablet/Mobile TOC (drawer) */}
        {isTocOpen && (
          <>
            <TocOverlay onClick={() => setIsTocOpen(false)} />
            <TocDrawer
              toc={toc}
              active={activeHeading}
              onSelect={() => setIsTocOpen(false)}
            />
          </>
        )}

        {/* Content */}
        <ContentPanel
          markdown={markdownContent}
          onScroll={handleScroll}
        />
      </div>
    </div>
  )
}
```

---

## Accessibility

- ✅ Semantic HTML (nav, main, article)
- ✅ Keyboard navigation (Tab through TOC, Enter to select)
- ✅ ARIA labels for interactive elements
- ✅ Color contrast (WCAG AA)
- ✅ Screen reader support (heading structure)
- ✅ Focus indicators visible

---

## Future Enhancements (Phase 2C+)

- [ ] Search within document (Ctrl+F)
- [ ] Copy heading link (click heading → copy anchor URL)
- [ ] Dark/light theme toggle
- [ ] Font size adjustment
- [ ] Print to PDF button
- [ ] Breadcrumb navigation

---

## References

- **Current Implementation**: `DocumentViewer` in `frontend-src/src/pages/`
- **Red Shrimp Lab Design**: `PRD-前端设计规范.md`
- **Color Scheme**: Cyan (#00d4ff), Dark (#1a1a2e), Borders (#0f3460)

---

**Design Status**: Ready for Implementation
**Requested by**: @Jwt2077
**Designed by**: @Atlas
**For Implementation**: @Alice
**For Review**: @Astra
