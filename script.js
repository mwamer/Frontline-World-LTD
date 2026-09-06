// Toggle mobile menu
function toggleMenu() {
    const navLinks = document.querySelector('.nav-links');
    navLinks.classList.toggle('active');
}

// Close menu when a link is clicked
document.querySelectorAll('.nav-links a').forEach(link => {
    link.addEventListener('click', () => {
        document.querySelector('.nav-links').classList.remove('active');
    });
});

// Handle contact form submission
function handleContactForm(event) {
    event.preventDefault();
    
    const form = event.target;
    
    // Get values by element id/name if available, falling back to form elements
    const fullNameInput = form.querySelector('#fullName') || form.elements['fullName'] || form.elements[0];
    const organisationInput = form.querySelector('#organisation') || form.elements['organisation'];
    const emailInput = form.querySelector('#email') || form.elements['email'] || form.elements[1];
    const messageInput = form.querySelector('#message') || form.elements['message'] || form.elements[3];

    const fullName = fullNameInput ? fullNameInput.value.trim() : '';
    const email = emailInput ? emailInput.value.trim() : '';
    const message = messageInput ? messageInput.value.trim() : '';
    const organisation = organisationInput ? organisationInput.value.trim() : '';
    
    // Simple validation
    if (!fullName || !email || !message || (organisationInput && !organisation)) {
        alert('Please fill in all required fields marked with *');
        return;
    }
    
    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        alert('Please enter a valid email address');
        return;
    }
    
    // Show success message
    alert('Thank you for your enquiry! Frontline World will review your details and get back to you shortly.');
    form.reset();
}

// Helper function to select an Area of Interest checkbox and scroll to form
function selectAreaOfInterest(value) {
    const checkboxes = document.querySelectorAll('input[name="interest"]');
    checkboxes.forEach(cb => {
        if (cb.value === value) {
            cb.checked = true;
        }
    });
    focusContactForm();
}

// Helper function to select Preferred Next Step checkbox and scroll to form
function selectPreferredNextStep(value) {
    const checkboxes = document.querySelectorAll('input[name="nextStep"]');
    checkboxes.forEach(cb => {
        if (cb.value === value) {
            cb.checked = true;
        }
    });
    focusContactForm();
}

// Helper function to scroll to and focus form
function focusContactForm() {
    const section = document.getElementById('contact-form-section');
    if (section) {
        section.scrollIntoView({ behavior: 'smooth' });
    }
    const firstInput = document.getElementById('fullName');
    if (firstInput) {
        setTimeout(() => firstInput.focus(), 400);
    }
}

// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            target.scrollIntoView({ behavior: 'smooth' });
        }
    });
});

// Add active class to current page in navigation
window.addEventListener('load', () => {
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.nav-links a').forEach(link => {
        const href = link.getAttribute('href').split('/').pop() || 'index.html';
        if (href === currentPage) {
            link.classList.add('active');
        }
    });
});