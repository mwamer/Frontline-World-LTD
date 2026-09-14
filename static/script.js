// ---- Mobile menu ----
function toggleMenu(event) {
    const navLinks = document.querySelector('.nav-links');
    if (!navLinks) return;
    const isOpen = navLinks.classList.toggle('active');
    const toggleButton = event ? event.currentTarget : document.querySelector('.nav-toggle');
    if (toggleButton && toggleButton.hasAttribute('aria-expanded')) {
        toggleButton.setAttribute('aria-expanded', String(isOpen));
    }
}

document.querySelector('.nav-toggle').addEventListener('click', toggleMenu);

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

// ---- Solidify the transparent header once the page scrolls ----
function updateHeaderOnScroll() {
    const header = document.querySelector('.site-header');
    if (!header) return;
    header.classList.toggle('scrolled', window.scrollY > 10);
}

updateHeaderOnScroll();
window.addEventListener('scroll', updateHeaderOnScroll, { passive: true });

// ---- Scroll reveal ----
function initReveal() {
    const items = document.querySelectorAll('.reveal');
    if (!items.length) return;

    // Stagger siblings that share the same parent grid
    items.forEach(item => {
        const siblings = item.parentElement
            ? item.parentElement.querySelectorAll('.reveal')
            : null;
        if (siblings && siblings.length > 1) {
            const index = Array.prototype.indexOf.call(siblings, item);
            item.style.transitionDelay = `${(index % 6) * 90}ms`;
        }
    });

    if (!('IntersectionObserver' in window)) {
        items.forEach(item => item.classList.add('is-visible'));
        return;
    }

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('is-visible');
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

    items.forEach(item => observer.observe(item));
}

initReveal();

// ---- Respect reduced-motion preference for JS-driven scrolling ----
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
            scrollToElement(target);
        }
    });
});