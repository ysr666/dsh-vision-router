# Client UI lifecycle and onboarding notes

These implementation notes are kept outside the self-contained browser module to preserve the project's 256 KiB review limit. The source comments still point to each section. No runtime behavior was extracted or changed.

## Walkthrough spotlight geometry

    // ── walkthrough spotlight: highlight the real UI targets ────────────────
    // The walkthrough overlays are plain DOM: a dimmed backdrop with a "hole"
    // over the current target (classic box-shadow spotlight), a pulsing ring
    // around it, and the prompt card anchored beside the target with an arrow
    // pointing at it. Everything is pointer-events:none except the prompt, so
    // the real controls stay clickable the whole time.
    //
    // DSH web hashes its CSS-module class names (unstable across builds), so
    // the targets are addressed through the stable surface instead: slot
    // wrappers (data-slot), data-composer-card and aria-haspopup/aria-label
    // attributes. Each step keeps a fallback chain, and when nothing matches
    // the prompt degrades to a corner card with a directional arrow.

## Onboarding step controls

      // Every step that is not the last one gets a Next button, so the two
      // floating prompts stay symmetric. Step 1's Next advances the stored
      // step; step 2's Next performs the current phase's action for the
      // user — opening the settings panel, then entering the Vision Router
      // section — so the walkthrough can be driven entirely from the prompt
      // without touching the real controls.

## Provider-model draft rows

        // Rows persist as { provider, model } objects while editing — an
        // incomplete row (provider picked, model pending) stays visible
        // instead of collapsing, which is what made the provider dropdown
        // feel unselectable before. Like the vision backend chain above, an
        // empty configuration still renders one blank row ready to fill.

## Two-select routing row

        // Same two-select row shape as the vision backend chain above: a
        // provider dropdown (providers that have excluded models) and a model
        // dropdown (that provider's excluded models). A row the user already
        // selected elsewhere stays disabled in the other rows. Option sets
        // come from the memoized top-level hooks (this function is plain
        // render code and must stay hook-free).

## Catalog render-phase bootstrap

      // Render-phase kick: whenever the body is open and the catalog was never
      // fetched (including after a remount that reset the state), start the
      // fetch. React supports setState during render for the same component,
      // and the status flips to 'loading' so this cannot loop. The same kick
      // runs the cheap test-connection probe once so the Host-owned official
      // provider availability notice can render without a button click.

## Onboarding replay

                    // Re-viewing the guide replays it from the beginning:
                    // leave the settings modal first (its panel closes on
                    // Escape), show the overview (steps 1-3), and then walk
                    // through step 1 on the chat page — starting in place
                    // would skip the session/text-model step entirely.
