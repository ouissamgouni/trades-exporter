#!/usr/bin/env python3
"""
Script to assign random colors from the palette to all categories that don't have a color.
Colors are assigned per dimension to ensure variety within each dimension.
"""

import sys
from pathlib import Path

# Add backend to path for proper imports
backend_path = Path(__file__).parent.parent.parent
sys.path.insert(0, str(backend_path))

from sqlmodel import select
from backend.db.database import get_session
from backend.db.models import Category, Dimension

# Chart-friendly color palette (same as frontend)
CATEGORY_COLOR_PALETTE = [
    # Blues
    '#4E79A7',  # Steel blue
    '#6B9AC4',  # Light steel
    '#2E5A87',  # Dark steel
    '#3C8DBC',  # Medium blue
    
    # Teals & Cyans
    '#59A89C',  # Teal
    '#76B7B2',  # Soft teal
    '#2D8B84',  # Deep teal
    '#4FB3A4',  # Vibrant teal
    
    # Greens
    '#8CD17D',  # Sage green
    '#59A14F',  # Forest green
    '#A0CB8D',  # Soft sage
    '#7FBF7F',  # Soft lime green
    
    # Yellows & Ochres
    '#F1CE63',  # Soft gold
    '#D4A84B',  # Ochre
    '#B6992D',  # Dark gold
    '#E6B800',  # Bright gold
    
    # Oranges
    '#F28E2B',  # Soft orange
    '#E07B39',  # Burnt orange
    '#FF9D5C',  # Light coral
    '#FF8C42',  # Warm coral orange
    
    # Reds & Pinks
    '#E15759',  # Soft red
    '#D4726A',  # Dusty rose
    '#B94A48',  # Deep red
    '#D26969',  # Muted crimson
    
    # Purples & Violets
    '#B07AA1',  # Dusty purple
    '#9467BD',  # Soft violet
    '#7B5A8C',  # Deep purple
    '#9B59B6',  # Rich lavender
    
    # Neutrals
    '#79706E',  # Warm gray
    '#A8A39E',  # Light taupe
    '#5E5855',  # Charcoal
    '#708090',  # Slate gray
    
    # Browns
    '#8B4513',  # Saddle brown
]


def get_next_available_color(used_colors: list[str], palette: list[str]) -> str:
    """Get the first color from palette not in used_colors, or cycle back."""
    used_lower = {c.lower() for c in used_colors if c}
    for color in palette:
        if color.lower() not in used_lower:
            return color
    # All used, cycle from beginning
    return palette[len(used_colors) % len(palette)]


def assign_colors():
    """Assign colors to all categories without colors, grouped by dimension."""
    with get_session() as session:
        # Get all dimensions
        dimensions = session.exec(select(Dimension)).all()
        
        total_updated = 0
        
        for dimension in dimensions:
            # Get categories for this dimension
            categories = session.exec(
                select(Category).where(Category.dimension_id == dimension.id)
            ).all()
            
            # Track used colors in this dimension
            used_colors = [c.color for c in categories if c.color]
            
            # Assign colors to categories without one
            for category in categories:
                if not category.color:
                    new_color = get_next_available_color(used_colors, CATEGORY_COLOR_PALETTE)
                    category.color = new_color
                    used_colors.append(new_color)
                    session.add(category)
                    total_updated += 1
                    print(f"  [{dimension.label}] {category.label} -> {new_color}")
        
        if total_updated > 0:
            print(f"\n✓ Updated {total_updated} categories with colors")
        else:
            print("✓ All categories already have colors assigned")


if __name__ == "__main__":
    print("Assigning colors to categories...\n")
    assign_colors()
