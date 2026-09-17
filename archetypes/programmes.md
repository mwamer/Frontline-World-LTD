---
# Frontline World Training Academy — course record schema
# One file per course. `hugo new programmes/<slug>.md` creates from this template.
# Leave unconfirmed fields empty or "To be announced". Never invent dates, prices,
# accreditation, certificates, or instructors.

title: "{{ replace .File.ContentBaseName "-" " " | title }}"
type: "programme"
url: "/training-academy/programmes/<slug>/"   # set the real slug here

# --- Basic information ---
course_id: ""                      # stable internal ID, e.g. FW-TA-006
short_title: ""                    # short display label for tight layouts
short_description: ""              # one-line card copy for the catalogue
description: ""                    # full description (page lead, meta description)
course_categories: []              # first entry = primary; 1+ from the 8 capability areas
keywords: []                       # course tags

# --- Audience ---
target_audience: ""                # who it is for, e.g. "Senior leaders & strategists"
audience_level: ""                 # career / professional level
audience_sector: []                # sectors served
prerequisites: ""                  # "To be announced" if unconfirmed
recommended_experience: ""

# --- Learning ---
learning_objectives: []            # list of statements
what_you_learn: []                 # what participants will learn
skills_developed: []               # skills / capabilities developed
expected_outcomes: []              # expected outcomes
modules: []                        # course structure, list of {name, description}

# --- Delivery ---
delivery_formats: []               # Online / In Person / Hybrid (repeatable)
duration: ""                       # "2 weeks" etc.
sessions_count: ""                 # number of sessions
session_length: ""                 # per session
location: ""                       # if in-person
max_participants: ""

# --- Commercial ---
course_type: ""                    # Open-enrolment / Executive / Bespoke / Workshop / Masterclass
price: ""                          # empty = To be announced
currency: ""
early_bird_price: ""
group_pricing: false               # true once group pricing exists
application_required: false
booking_status: "To be announced"

# --- Scheduling ---
status: "Draft"                    # Draft / Coming Soon / Open / Full / Closed
next_cohort: "To be announced"
start_date: ""                     # YYYY-MM-DD
end_date: ""
application_deadline: ""
future_cohorts: []                 # future cohort objects {start, end, deadline, status, price}

# --- Instructors ---
instructors: []                    # {name, profile, image} — multiple supported

# --- Media ---
image: ""                          # course image
hero_image: ""
additional_images: []
video_url: ""

# --- Administration ---
featured: false
draft: true                       # Hugo-native publish gate; false = visible live
last_updated: {{ now.Format "2006-01-02" }}
internal_notes: ""
---

Full course description and narrative. Keep to confirmed facts.