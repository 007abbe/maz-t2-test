import { defineAgent } from '../contract.js'
import { renderFinski } from './ui.js'

export const finski = defineAgent({
  id: 'finski',
  title: 'Finski',
  subtitle: 'Pre-market brief · events and conditions — never direction',
  mount: renderFinski,
})
