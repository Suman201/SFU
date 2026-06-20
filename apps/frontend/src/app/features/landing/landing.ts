import { ChangeDetectionStrategy, Component } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Footer } from '../../shared/footer/footer';
import { Header } from '../../shared/header/header';

@Component({
  selector: 'sfu-landing',
  standalone: true,
  imports: [Footer, Header, NgTemplateOutlet, RouterLink],
  templateUrl: './landing.html',
  styleUrl: './landing.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class Landing {
  protected readonly heroBannerImage = '/assets/images/hero-banner.png';
  protected readonly heroImage = '/assets/images/hero-teacher.webp';
  protected readonly heroMapImage = '/assets/images/india-map-connection.webp';
  protected readonly indiaMapImage = '/assets/images/india-map.svg';
  protected readonly ctaImage = '/assets/images/cta-students.webp';
  protected readonly avatars = ['RS', 'SK', 'NI', 'AP', 'MJ'];

  protected readonly learnerCards = [
    { state: 'Rajasthan', tone: 'green', image: '/assets/images/student-rajasthan.webp' },
    { state: 'Bihar', tone: 'blue', image: '/assets/images/student-bihar.webp' },
    { state: 'Tamil Nadu', tone: 'rose', image: '/assets/images/student-tamilnadu.webp' },
    { state: 'Madhya Pradesh', tone: 'amber', image: '/assets/images/student-madhyapradesh.webp' }
  ];

  protected readonly stats = [
    { value: '10,000+', label: 'Teachers', icon: 'cap', tone: 'blue' },
    { value: '5,00,000+', label: 'Learners', icon: 'users', tone: 'green' },
    { value: '25,000+', label: 'Live Classes', icon: 'play', tone: 'orange' },
    { value: '8,000+', label: 'Courses', icon: 'book', tone: 'purple' },
    { value: '4.8/5', label: 'User Rating', icon: 'star', tone: 'pink' },
    { value: '28', label: 'States Covered', icon: 'globe', tone: 'cyan' }
  ];

  protected readonly benefits = [
    {
      title: 'Bridge the Urban-Rural Gap',
      body: 'City-based teachers can reach and educate students in remote and rural areas.',
      icon: 'bridge',
      tone: 'green'
    },
    {
      title: 'Affordable Learning for Everyone',
      body: 'Students gain access to quality education at a fraction of traditional costs.',
      icon: 'rupee',
      tone: 'orange'
    },
    {
      title: 'No Platform Development Required',
      body: 'Teachers can start teaching immediately without building websites or managing infrastructure.',
      icon: 'screen',
      tone: 'blue'
    },
    {
      title: 'Generate Additional Income',
      body: 'Monetize your expertise and reach a wider audience across the country.',
      icon: 'bars',
      tone: 'green'
    },
    {
      title: 'Learn from Anywhere',
      body: 'Students can attend classes from their homes using mobile phones or computers.',
      icon: 'home',
      tone: 'purple'
    },
    {
      title: 'Support Multiple Learning Formats',
      body: 'Live classes, recorded sessions, workshops, mentorship, and skill courses.',
      icon: 'video',
      tone: 'pink'
    },
    {
      title: 'Promote Digital Inclusion',
      body: 'Contribute to the Digital India vision by making quality education accessible to all.',
      icon: 'globe',
      tone: 'cyan'
    },
    {
      title: 'Build a Knowledge-Sharing Community',
      body: 'Connect teachers, students, mentors, and experts on a single collaborative platform.',
      icon: 'community',
      tone: 'amber'
    }
  ];

  protected readonly steps = [
    { title: 'Sign Up', body: 'Create your free account as a teacher or learner.', icon: 'person-add', tone: 'green' },
    { title: 'Explore', body: 'Browse courses, teachers, and learning programs that match your goals.', icon: 'id-card', tone: 'blue' },
    { title: 'Learn/Teach', body: 'Join live classes, access recorded content, or start teaching your expertise.', icon: 'camera', tone: 'purple' },
    { title: 'Engage', body: 'Interact, ask questions, and collaborate in a vibrant community.', icon: 'group', tone: 'orange' },
    { title: 'Grow', body: 'Gain knowledge, earn certificates, and unlock new opportunities.', icon: 'badge', tone: 'green' }
  ];

  protected readonly platformBenefits = [
    { label: 'Online Classes', icon: 'screen', tone: 'blue' },
    { label: 'Skill Development', icon: 'gears', tone: 'green' },
    { label: 'Affordable Pricing', icon: 'rupee', tone: 'orange' },
    { label: 'Community Learning', icon: 'community', tone: 'purple' },
    { label: 'Digital India', icon: 'signal', tone: 'orange' },
    { label: 'Employment Opportunities', icon: 'briefcase', tone: 'blue' },
    { label: 'Rural Empowerment', icon: 'village', tone: 'amber' },
    { label: 'Better Future for All', icon: 'leaf', tone: 'green' }
  ];

  protected readonly testimonials = [
    {
      quote: 'EDCONNECTION has allowed me to reach thousands of students in rural India. I can teach what I love and make a real impact.',
      name: 'Rahul Sharma',
      role: 'Physics Teacher, Delhi',
      badge: 'Teacher',
      tone: 'green',
      image: '/assets/images/testimonial-1.webp'
    },
    {
      quote: 'I can now learn from the best teachers without leaving my village. It is affordable and the classes are amazing.',
      name: 'Sunita Kumari',
      role: 'Class 11 Student, Bihar',
      badge: 'Learner',
      tone: 'blue',
      image: '/assets/images/testimonial-2.webp'
    },
    {
      quote: 'The platform is very easy to use and has opened new income opportunities for me while helping students grow.',
      name: 'Neha Iyer',
      role: 'Dance Instructor, Mumbai',
      badge: 'Teacher',
      tone: 'amber',
      image: '/assets/images/testimonial-3.webp'
    }
  ];
}
