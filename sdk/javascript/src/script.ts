import {zbucket} from './browser';
// Explicit initialization keeps consent and authenticated context under application control.
Object.assign(window,{zbucket,warehouse:zbucket});
