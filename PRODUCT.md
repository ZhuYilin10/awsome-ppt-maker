# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

User-confirmed: Electron + React + TypeScript desktop application, Pi SDK as the embedded Agent runtime, OfficeCLI as the Office document tool layer, and SQLite for local project records. The UI uses the Electron DOM rather than native mobile widgets.

## Users

People who need to improve an existing formal PowerPoint deck while preserving its content, fixed template elements, and editability.

## Product Purpose

The product helps a user turn an existing PPT into a consistent, polished, editable presentation. It first uses representative pages to establish a visual direction, then turns the user's feedback into a design specification and applies that specification to the full deck.

## Positioning

The product does not ask users to approve a vague text plan. It lets them repeatedly review real page previews, lock a preferred direction, and carry that approved visual standard into the full production run.

## Operating Context

Projects are local desktop workspaces. A project may contain a primary PPTX, reference documents, images, brand assets, and per-material usage notes. The first workflow is material intake; later workflows will add representative-page planning, design-spec confirmation, full-deck production, and export.

## Capabilities and Constraints

- A project can contain multiple imported materials.
- Every material can have a purpose and a user-written instruction.
- The primary PPTX is the document to be beautified; other materials can provide content, visual reference, or assets.
- The product must preserve editable Office output whenever the source and toolchain support it.
- Plan and Build are separate product phases. Plan may create editable working drafts and previews; Build applies a confirmed design specification to the deck.
- The application is local-first. Model/API credentials must not be placed in the renderer UI bundle.

## Product Principles

- Show the real page, not only a textual promise about the page.
- Preserve user content and fixed elements unless the user explicitly permits a change.
- Let the user distinguish a page-specific correction from a deck-wide design rule.
- Keep the approved sample pages and design specification linked to the produced deck.
- Make every long-running Agent action observable, interruptible, and recoverable.
