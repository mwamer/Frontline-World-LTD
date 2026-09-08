// Toggle mobile menu
function toggleMenu(event) {
    const navLinks = document.querySelector('.nav-links');
    const isOpen = navLinks.classList.toggle('active');
    const toggleButton = event ? event.currentTarget : document.querySelector('.nav-toggle');
    if (toggleButton && toggleButton.hasAttribute('aria-expanded')) {
        toggleButton.setAttribute('aria-expanded', String(isOpen));
    }
}

function closeMenu() {
    const navLinks = document.querySelector('.nav-links');
    const toggleButton = document.querySelector('.nav-toggle');
    navLinks.classList.remove('active');
    if (toggleButton) {
        toggleButton.setAttribute('aria-expanded', 'false');
    }
}

// Close menu when a link is clicked
document.querySelectorAll('.nav-links a').forEach(link => {
    link.addEventListener('click', closeMenu);
});

// Close menu on Escape key or when clicking outside the nav
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeMenu();
    }
});

document.addEventListener('click', (e) => {
    const nav = document.querySelector('.navbar');
    if (nav && !nav.contains(e.target)) {
        closeMenu();
    }
});

// On mobile, start the expertise accordion collapsed (except the first item)
function initExpertiseAccordion() {
    const items = document.querySelectorAll('.expertise-item');
    if (!items.length || window.innerWidth >= 768) return;
    items.forEach((item, index) => {
        item.open = index === 0;
    });
}

initExpertiseAccordion();

// Solidify the transparent navbar once the page scrolls past the top
function updateNavbarOnScroll() {
    const navbar = document.querySelector('.navbar');
    if (!navbar) return;
    navbar.classList.toggle('scrolled', window.scrollY > 10);
}

updateNavbarOnScroll();
window.addEventListener('scroll', updateNavbarOnScroll, { passive: true });

// Respect the user's reduced-motion preference for JS-driven scrolling
function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function scrollToElement(element) {
    element.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
        const targetId = this.getAttribute('href');
        const target = document.querySelector(targetId);
        if (target) {
            e.preventDefault();
            if (target.classList.contains('expertise-item')) {
                target.open = true;
            }
            scrollToElement(target);
        }
    });
});
