---
# The six course files in this folder are not published under /courses/: each
# one sets url to /training-academy/courses/<slug>/, because the site's public
# training landing page is /training-academy/. This folder is a container, not
# a page.
#
# Hugo still builds a section node for the folder. That node has no list
# template, so the build warns about a missing layout, and the node would be
# advertised in the sitemap as a /courses/ URL that is never generated. Two
# front matter keys fix both, and nothing outside this folder changes:
# build.render stops Hugo rendering a page for the node, and sitemap.disable
# keeps it out of the sitemap.
#
# /courses/ itself is not a dead end: the alias in content/training-academy.html
# sends that URL to the Training Academy page, so the folder keeps one canonical
# public URL and does not gain a second course listing.
#
# build.list is deliberately not set: `never` here would also drop the course
# pages out of the listings and the home page RSS feed.
#
# A course may carry one further front matter key of its own:
#
#   programme: <a stable programme identifier>
#
# It says which learning pathway the course belongs to, and it is the same
# identifier the matching key on a course's assignment record uses. A programme
# is a container of one or more courses, so the key is a pointer into the
# catalogue rather than a description of the course.
#
# All six courses set it, each to exactly one programme, and the build fails if
# a course names a programme that does not exist. The key is read in three
# places, all of which are lists rather than copies: a programme page collects
# the courses that name it, the Academy page lists the courses inside each
# programme card, and its Courses grid orders courses by the programme they
# belong to. So changing a course's `programme:` moves it between programmes on
# every page at once, and nothing needs editing to keep the lists agreeing.
#
# The Academy presents Programmes and Courses and nothing between them. A
# programme family is a data-model level that orders the programme list, and no
# family grouping is shown to a visitor: see layouts/shortcodes/
# academy-catalogue.html and the "How the Academy page presents the catalogue"
# section of README.md.
#
# A course's own page is the single source for what its catalogue card says.
# The card on the Training Academy page reads the course's <h1> for the name,
# its <p class="page-lead"> for the description, and the Audience and Format
# lines in its <div class="course-facts"> for the delivery facts, through
# course-name.html, course-lead.html and course-facts.html. A course that states
# no facts block gets a card with no facts line rather than an invented one.
# Editing a sentence on the course page therefore updates every list of that
# course, which is the point: there is no second copy to fall out of step.
#
# A course may add an optional `summary:` to its front matter to give the card a
# shorter description than its page lead, for a page whose opening paragraph is
# written to be read rather than scanned. The key covers the card only: the
# course page still opens with its own <p class="page-lead">, and the key's
# fallback order is `summary:`, then the lead, then the page's meta description.
# Only strategic-foresight-for-leaders sets it, because its lead is 155
# characters and reads as a paragraph rather than a card line.
#
# Three URL namespaces are in play, and they are distinct:
#
#   /training-academy/courses/<slug>/      a course's canonical URL, set in
#                                          this file's front matter. Not
#                                          optional, and not to be changed.
#   /training-academy/programmes/<slug>/   a course's legacy alias, also
#                                          declared in this file's front
#                                          matter. Kept so old links keep
#                                          resolving; it is a redirect and
#                                          holds no content of its own.
#   /programmes/<slug>/                    reserved for programme pages only.
#
# The first two are both written by a course. The third is not a course's to
# write, and the build enforces that: programmes-validate.html fails the build
# if any page outside the content/programmes/ section publishes anywhere under
# /programmes/. So if a course is ever given a url: inside that namespace, the
# build stops and names the file rather than quietly colliding with a programme
# page.
#
# Note that the two "programmes" namespaces are unrelated despite the shared
# word: the first is a historic course alias kept for continuity, the second is
# the programme namespace. Neither is a child of the other.
sitemap:
  disable: true
build:
  render: never
title: "Courses"
---
