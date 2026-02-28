import random
import json

FIRST_NAMES = [
    "Alice", "Bob", "Charlie", "Diana", "Edward",
    "Fiona", "George", "Hannah", "Ivan", "Julia",
    "Kevin", "Laura", "Michael", "Natalie", "Oscar",
    "Paula", "Quentin", "Rachel", "Steve", "Tina",
]

LAST_NAMES = [
    "Smith", "Johnson", "Williams", "Brown", "Jones",
    "Garcia", "Miller", "Davis", "Martinez", "Wilson",
    "Anderson", "Taylor", "Thomas", "Jackson", "White",
    "Harris", "Martin", "Thompson", "Robinson", "Lewis",
]

CITIES = [
    "New York", "Los Angeles", "Chicago", "Houston", "Phoenix",
    "Philadelphia", "San Antonio", "San Diego", "Dallas", "San Jose",
    "Austin", "Jacksonville", "Fort Worth", "Columbus", "Charlotte",
    "Indianapolis", "San Francisco", "Seattle", "Denver", "Nashville",
]

DOMAINS = ["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "example.com"]


def generate_profile():
    """Generate a single random user profile."""
    first = random.choice(FIRST_NAMES)
    last = random.choice(LAST_NAMES)
    name = f"{first} {last}"
    email = f"{first.lower()}.{last.lower()}{random.randint(1, 999)}@{random.choice(DOMAINS)}"
    age = random.randint(18, 75)
    city = random.choice(CITIES)
    return {
        "name": name,
        "email": email,
        "age": age,
        "city": city,
    }


def save_profiles(n, filename):
    """Generate n random profiles and save them to a JSON file."""
    profiles = [generate_profile() for _ in range(n)]
    with open(filename, "w", encoding="utf-8") as f:
        json.dump(profiles, f, indent=2, ensure_ascii=False)
    return profiles


if __name__ == "__main__":
    save_profiles(10, "profiles.json")
    print("10 profiles saved to profiles.json")
