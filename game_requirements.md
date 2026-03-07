# Game Requirements & Specifications: Dark Echo

## 1. Project Overview
- **Title**: Dark Echo (Formerly Dark Current / Dark Signal)
- **Genre**: Space RTS (Real-Time Strategy) with Submarine-combat mechanics
- **Platform**: Android Mobile (Prototype to be built as Web App)
- **Engine**: Unity (Web tech for Prototype)
- **Core Concept**: Submarine-style warfare in space. The battlefield is filled with a dark matter fog, requiring players to locate invisible enemies using various sensors (heat, electromagnetic, etc.) before striking.

## 2. World & Lore
- **Erebos**: The dark matter fog that fills space. It was caused by the phase transition of dark matter triggered by unknown cosmic rays. It obstructs vision and electronic warfare.
- **Talos**: The humanoid autonomous combat mechas deployed alongside ships.

## 3. Core Gameplay & Mechanics
- **Fog of War & Detection**: Enemies are not visible by default. Players must use parameters (radar, sonar equivalents) to detect them. Detected enemies appear brightly.
- **Movement & Pacing**: Tactical, slow-paced movement based on ship generator output. Players tap/click to set a destination.
- **Combat**: Pre-emptive strikes are highly advantageous. Once engaged, visually spectacular fleet battles occur.
- **Single Player**: Initially focused on player vs. CPU combat with local save functionality.

## 4. UI & Controls (Homeworld 2 style)
- **Field View**: The battlefield is vast (roughly 10x the screen size). Players can drag to scroll the camera and zoom in/out.
- **Minimap**: Located at the bottom left. 
  - Green dots: Player units
  - Red dots: Enemy units (when detected)
  - Yellow frame: Current camera view
  - Clicking the minimap instantly moves the camera.
- **Console/Menu**: Gathered at the bottom of the screen.

## 5. Development Scope for Web Prototype
- 2D/2.5D top-down approximation using HTML5 Canvas or WebGL (Three.js).
- Simple unit movement (slow, point-and-click).
- Field larger than the screen with drag-to-pan and minimap.
- Fog of War: Enemies are hidden until they enter sensor range.
